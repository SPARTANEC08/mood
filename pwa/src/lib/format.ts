/**
 * Мелкие правила отображения, общие для нескольких экранов.
 *
 * Сюда вынесены функции, которые раньше лежали копиями в страницах
 * (gradeColor/scoreColor, shortKindLabel и т. п.). Копии неизбежно
 * разъезжались: экран успеваемости и экран предмета по-разному красили один и
 * тот же балл. Один модуль держит правило в одном месте.
 */

/**
 * Цвет балла по пятибалльной шкале.
 *
 * Единое правило для легенды распределения, дисциплин и КМ: 5 — зелёный,
 * 4 — оранжевый, 3 — жёлтый, 2 — красный.
 */
export function gradeColor(score: number): string {
  if (score >= 4.5) return 'var(--grade-5)';
  if (score >= 3.5) return 'var(--grade-4)';
  if (score >= 2.5) return 'var(--grade-3)';
  return 'var(--grade-2)';
}

/** Короткая подпись типа занятия из строки МЭИ («Практическое занятие» → «Практ.»). */
export function shortKindLabel(kindOfWork: string): string {
  const raw = (kindOfWork || '').toLowerCase();
  if (raw.includes('лаб')) return 'Лаб';
  if (raw.includes('лек')) return 'Лекция';
  if (raw.includes('практ')) return 'Практ.';
  if (raw.includes('семин')) return 'Семинар';
  return 'Занятие';
}
