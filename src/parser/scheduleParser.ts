import {
  FormattedLecturer,
  MpeiRawLesson,
  MpeiSearchResult,
  ParsedLessonSlot,
  ParsedLessonVariant,
  ParsedSchedule,
  ParsedScheduleDay,
} from './types.ts';

const DAY_NAMES_RU: Record<number, { full: string; short: string }> = {
  1: { full: 'Понедельник', short: 'Пн' },
  2: { full: 'Вторник', short: 'Вт' },
  3: { full: 'Среда', short: 'Ср' },
  4: { full: 'Четверг', short: 'Чт' },
  5: { full: 'Пятница', short: 'Пт' },
  6: { full: 'Суббота', short: 'Сб' },
  7: { full: 'Воскресенье', short: 'Вс' },
};

/**
 * Converts date from YYYY.MM.DD to DD.MM.YYYY
 */
export function formatDisplayDate(rawDate: string): string {
  if (!rawDate) return '';
  const parts = rawDate.split('.');
  if (parts.length === 3) {
    const [year, month, day] = parts;
    return `${day.padStart(2, '0')}.${month.padStart(2, '0')}.${year}`;
  }
  return rawDate;
}

/**
 * Cleans string or returns undefined if empty or placeholder
 */
function cleanString(str?: string | null): string | undefined {
  if (!str) return undefined;
  const trimmed = str.trim();
  if (!trimmed || trimmed === '!Не определена' || trimmed === '!Вакансия') return undefined;
  return trimmed;
}

/**
 * Extracts and cleans lecturers list from a raw lesson
 */
function extractLecturers(raw: MpeiRawLesson): {
  primaryShort: string;
  primaryFull: string;
  primaryRank?: string;
  all: FormattedLecturer[];
} {
  const all: FormattedLecturer[] = [];

  if (raw.listOfLecturers && raw.listOfLecturers.length > 0) {
    for (const item of raw.listOfLecturers) {
      const shortName = cleanString(item.lecturer) || '';
      const fullName = cleanString(item.lecturer_title) || '';
      const rank = cleanString(item.lecturer_rank);
      if (shortName || fullName) {
        all.push({
          shortName: shortName || fullName,
          fullName: fullName || shortName,
          rank,
        });
      }
    }
  }

  // Fallback to top-level fields
  if (all.length === 0) {
    const shortName = cleanString(raw.lecturer) || 'Преподаватель не указан';
    const fullName = cleanString(raw.lecturer_title) || shortName;
    const rank = cleanString(raw.lecturer_rank);
    all.push({
      shortName,
      fullName,
      rank,
    });
  }

  const primaryShort = all[0]?.shortName || cleanString(raw.lecturer) || 'Преподаватель не указан';
  const primaryFull = all[0]?.fullName || cleanString(raw.lecturer_title) || primaryShort;
  const primaryRank = all[0]?.rank || cleanString(raw.lecturer_rank);

  return { primaryShort, primaryFull, primaryRank, all };
}

/**
 * Parses raw lesson list into hierarchical, structured ParsedSchedule
 */
export function parseSchedule(
  rawLessons: MpeiRawLesson[],
  groupInfo: { label: string; id: number; description?: string }
): ParsedSchedule {
  if (!rawLessons || rawLessons.length === 0) {
    return {
      groupName: groupInfo.label,
      groupId: groupInfo.id,
      facultyName: groupInfo.description || '',
      parentScheduleName: '',
      totalLessons: 0,
      dateRange: { start: '', finish: '' },
      days: [],
      rawLessons: [],
    };
  }

  // Sort raw lessons by date ascending, then lessonNumberStart, then beginLesson, then subgroup
  const sortedLessons = [...rawLessons].sort((a, b) => {
    if (a.date !== b.date) {
      return a.date.localeCompare(b.date);
    }
    if (a.lessonNumberStart !== b.lessonNumberStart) {
      return a.lessonNumberStart - b.lessonNumberStart;
    }
    if (a.beginLesson !== b.beginLesson) {
      return a.beginLesson.localeCompare(b.beginLesson);
    }
    const subA = a.subGroup || '';
    const subB = b.subGroup || '';
    return subA.localeCompare(subB);
  });

  const facultyName =
    sortedLessons.find((l) => l.group_facultyname)?.group_facultyname ||
    groupInfo.description ||
    '';
  const parentScheduleName =
    sortedLessons.find((l) => l.parentschedule)?.parentschedule || '';
  const courseNumber = sortedLessons.find((l) => l.courseContent)?.courseContent;

  const minDate = sortedLessons[0].date;
  const maxDate = sortedLessons[sortedLessons.length - 1].date;

  // Group by date (YYYY.MM.DD)
  const daysMap = new Map<string, MpeiRawLesson[]>();
  for (const lesson of sortedLessons) {
    if (!daysMap.has(lesson.date)) {
      daysMap.set(lesson.date, []);
    }
    daysMap.get(lesson.date)!.push(lesson);
  }

  const days: ParsedScheduleDay[] = [];

  for (const [rawDate, dayLessons] of daysMap.entries()) {
    const firstLesson = dayLessons[0];
    const dayOfWeek = firstLesson.dayOfWeek || 1;
    const dayNameInfo = DAY_NAMES_RU[dayOfWeek] || {
      full: firstLesson.dayOfWeekString || 'День недели',
      short: firstLesson.dayOfWeekString || '',
    };

    // Group lessons on this day by slot key (e.g. lessonNumberStart + beginLesson + endLesson)
    const slotMap = new Map<string, MpeiRawLesson[]>();

    for (const lesson of dayLessons) {
      const slotKey = `${lesson.lessonNumberStart}_${lesson.beginLesson}_${lesson.endLesson}`;
      if (!slotMap.has(slotKey)) {
        slotMap.set(slotKey, []);
      }
      slotMap.get(slotKey)!.push(lesson);
    }

    const slots: ParsedLessonSlot[] = [];

    for (const [, slotLessons] of slotMap.entries()) {
      const baseLesson = slotLessons[0];

      const variants: ParsedLessonVariant[] = slotLessons.map((lesson) => {
        const { primaryShort, primaryFull, primaryRank, all } = extractLecturers(lesson);

        // Subgroup extraction
        let subgroup: string | undefined = undefined;
        if (lesson.subGroup) {
          subgroup = lesson.subGroup;
        } else if (lesson.listSubGroups && lesson.listSubGroups.length > 0) {
          subgroup = lesson.listSubGroups.map((s) => s.subgroup).join(', ');
        }

        // Online URLs
        const onlineUrls: Array<{ url: string; description?: string }> = [];
        if (lesson.url1 && lesson.url1.trim()) {
          onlineUrls.push({
            url: lesson.url1.trim(),
            description: cleanString(lesson.url1_description),
          });
        }
        if (lesson.url2 && lesson.url2.trim()) {
          onlineUrls.push({
            url: lesson.url2.trim(),
            description: cleanString(lesson.url2_description),
          });
        }

        // Joint groups
        const jointGroups: string[] = [];
        if (lesson.listGroups && lesson.listGroups.length > 0) {
          for (const g of lesson.listGroups) {
            if (g.group && g.group !== groupInfo.label) {
              jointGroups.push(g.group);
            }
          }
        }

        return {
          discipline: lesson.discipline || 'Дисциплина не указана',
          kindOfWork: lesson.kindOfWork || 'Занятие',
          auditorium: lesson.auditorium || 'Аудитория не указана',
          building: lesson.building || '',
          auditoriumCapacity:
            lesson.auditoriumAmount && lesson.auditoriumAmount > 0
              ? lesson.auditoriumAmount
              : undefined,
          lecturerShort: primaryShort,
          lecturerFullName: primaryFull,
          lecturerRank: primaryRank,
          allLecturers: all,
          subgroup,
          stream: cleanString(lesson.stream),
          jointGroups,
          onlineUrls,
          note: cleanString(lesson.note) || cleanString(lesson.note_description),
          replaces: cleanString(lesson.replaces),
          duration: lesson.duration,
          timetableName: cleanString(lesson.tableofLessonsName),
          raw: lesson,
        };
      });

      slots.push({
        lessonNumber: baseLesson.lessonNumberStart,
        lessonNumberEnd: baseLesson.lessonNumberEnd || baseLesson.lessonNumberStart,
        timeStart: baseLesson.beginLesson,
        timeEnd: baseLesson.endLesson,
        variants,
      });
    }

    // Sort slots by lesson number
    slots.sort((a, b) => a.lessonNumber - b.lessonNumber || a.timeStart.localeCompare(b.timeStart));

    days.push({
      date: formatDisplayDate(rawDate),
      rawDate,
      dayOfWeek,
      dayName: dayNameInfo.full,
      dayShort: dayNameInfo.short,
      slots,
    });
  }

  return {
    groupName: groupInfo.label,
    groupId: groupInfo.id,
    facultyName,
    parentScheduleName,
    courseNumber,
    totalLessons: sortedLessons.length,
    dateRange: {
      start: formatDisplayDate(minDate),
      finish: formatDisplayDate(maxDate),
    },
    days,
    rawLessons: sortedLessons,
  };
}
