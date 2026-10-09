/**
 * Types representing official NRU MPEI (НИУ МЭИ) schedule API responses and parsed data.
 * Official source: ts.mpei.ru (Информационная система «Расписание учебных занятий» / ИС РУЗ)
 */

export interface MpeiSearchResult {
  id: number;
  label: string;
  description: string;
  type: 'group' | 'student' | 'lecturer' | 'auditorium';
}

export interface MpeiRawLecturer {
  lecturer: string;
  lecturerASAV_UID?: string | null;
  lecturerCustomUID?: string | null;
  lecturerEmail?: string | null;
  lecturerGUID?: string | null;
  lecturerMDM_UID?: string | null;
  lecturerOid?: number;
  lecturerUID?: string | null;
  lecturer_postASAV_UID?: string | null;
  lecturer_postMDM_UID?: string | null;
  lecturer_postUID?: string | null;
  lecturer_post_oid?: number;
  lecturer_rank?: string;
  lecturer_title?: string;
  personHR_Person_ID?: string | null;
  personMDM_Person_UID?: string | null;
}

export interface MpeiRawGroup {
  group: string;
  groupASAV_UID?: string | null;
  groupGUID?: string | null;
  groupGid?: number;
  groupHR_UID?: string | null;
  groupMDM_UID?: string | null;
  groupOid?: number;
  groupSP_Uid?: string | null;
  groupUID?: string | null;
  group_facultyASAV_UID?: string | null;
  group_facultyHR_UID?: string | null;
  group_facultyUID?: string | null;
  group_faculty_SP_Uid?: string | null;
  group_facultyname?: string | null;
  group_facultyoid?: number;
}

export interface MpeiRawSubGroup {
  subgroup: string;
  subgroupGUID?: string | null;
  subgroupGid?: number;
  subgroupOid?: number;
  subgroupUID?: string | null;
  subgroup_facultyoid?: number;
  subgroup_groupOid?: number;
}

export interface MpeiRawLesson {
  SP_DisciplineInPlan_ID?: string | null;
  auditorium: string;
  auditoriumAmount?: number;
  auditoriumGUID?: string;
  auditoriumOid?: number;
  auditoriumfloor?: number;
  author?: string;
  beginLesson: string;
  building: string;
  buildingGid?: number;
  buildingOid?: number;
  contentOfLoadOid?: number;
  contentOfLoadUID?: string | null;
  contentTableOfLessonsName?: string;
  contentTableOfLessonsOid?: number;
  courseContent?: number;
  createddate?: string;
  date: string; // YYYY.MM.DD
  dateOfNest?: string;
  dayOfWeek: number; // 1 (Пн) - 7 (Вс)
  dayOfWeekString: string; // Пн, Вт, Ср, Чт, Пт, Сб, Вс
  detailInfo?: string;
  discipline: string;
  disciplineASAV_UID?: string | null;
  disciplineMDM_UID?: string | null;
  disciplineOid?: number;
  disciplineUid?: string | null;
  disciplineinplan?: string | null;
  disciplinetypeload?: number;
  duration?: number;
  endLesson: string;
  group?: string | null;
  groupASAV_UID?: string | null;
  groupGUID?: string | null;
  groupHR_UID?: string | null;
  groupMDM_UID?: string | null;
  groupOid?: number;
  groupSP_Uid?: string | null;
  groupUID?: string | null;
  group_facultyASAV_UID?: string | null;
  group_facultyHR_UID?: string | null;
  group_facultyUID?: string | null;
  group_faculty_SP_Uid?: string | null;
  group_facultyname?: string | null;
  group_facultyoid?: number;
  hideincapacity?: number;
  isBan?: boolean;
  kindOfWork: string; // "Лекция", "Практическое занятие", "Лабораторная работа"
  kindOfWorkComplexity?: number;
  kindOfWorkOid?: number;
  kindOfWorkUid?: string | null;
  lecturer: string; // e.g. "доц. Бабаев Д.Д."
  lecturerASAV_UID?: string | null;
  lecturerCustomUID?: string | null;
  lecturerEmail?: string | null;
  lecturerGUID?: string | null;
  lecturerMDM_UID?: string | null;
  lecturerOid?: number;
  lecturerUID?: string | null;
  lecturer_postASAV_UID?: string | null;
  lecturer_postMDM_UID?: string | null;
  lecturer_postUID?: string | null;
  lecturer_post_oid?: number;
  lecturer_rank?: string; // e.g. "доц.", "ст.преп."
  lecturer_title?: string; // Full name: "Бабаев Джамиль Джониевич"
  lessonNumberEnd: number;
  lessonNumberStart: number;
  lessonOid?: number;
  listGroups?: MpeiRawGroup[];
  listOfLecturers?: MpeiRawLecturer[];
  listSubGroups?: MpeiRawSubGroup[];
  modifieddate?: string;
  note?: string | null;
  note_description?: string;
  openlesson?: number;
  packageNumber?: number;
  parentSchedule_Status?: number;
  parentschedule?: string;
  personHR_Person_ID?: string | null;
  personMDM_Person_UID?: string | null;
  replaces?: string | null;
  specializationContent?: string | null;
  specialization_name?: string | null;
  specialization_oid?: number;
  stream?: string | null;
  streamOid?: number;
  streamUid?: string | null;
  stream_facultyoid?: number;
  subGroup?: string | null;
  subGroupOid?: number;
  subgroupGUID?: string | null;
  subgroupUid?: string | null;
  subgroup_facultyoid?: number;
  subgroup_groupOid?: number;
  subject?: string | null;
  tableofLessonsName?: string;
  tableofLessonsOid?: number;
  typeOfContingent?: number;
  url1?: string;
  url1_description?: string;
  url2?: string;
  url2_description?: string;
}

export interface FormattedLecturer {
  shortName: string;
  fullName: string;
  rank?: string;
}

export interface ParsedLessonVariant {
  discipline: string;
  kindOfWork: string;
  auditorium: string;
  building: string;
  auditoriumCapacity?: number;
  lecturerShort: string;
  lecturerFullName: string;
  lecturerRank?: string;
  allLecturers: FormattedLecturer[];
  subgroup?: string;
  stream?: string;
  jointGroups: string[];
  onlineUrls: Array<{ url: string; description?: string }>;
  note?: string;
  replaces?: string;
  duration?: number;
  timetableName?: string;
  raw: MpeiRawLesson;
}

export interface ParsedLessonSlot {
  lessonNumber: number;
  lessonNumberEnd: number;
  timeStart: string;
  timeEnd: string;
  variants: ParsedLessonVariant[];
}

export interface ParsedScheduleDay {
  date: string; // DD.MM.YYYY
  rawDate: string; // YYYY.MM.DD
  dayOfWeek: number; // 1-7
  dayName: string; // Понедельник, Вторник, ...
  dayShort: string; // Пн, Вт, ...
  slots: ParsedLessonSlot[];
}

export interface ParsedSchedule {
  groupName: string;
  groupId: number;
  facultyName: string;
  parentScheduleName: string;
  courseNumber?: number;
  totalLessons: number;
  dateRange: {
    start: string;
    finish: string;
  };
  days: ParsedScheduleDay[];
  rawLessons: MpeiRawLesson[];
}
