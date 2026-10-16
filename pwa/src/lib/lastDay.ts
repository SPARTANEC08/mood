/**
 * Последний открытый день расписания — на пользователя.
 *
 * Зачем отдельно от общего кэша. Общий кэш (data/tier1) хранит расписание, ДЗ и
 * «Важное», но не то, какой день человек смотрел. Без этого при каждом
 * возврате на вкладку (страница пересоздаётся) выбирался «ближайший день», и
 * лента прыгала с анимацией, которой человек не просил.
 *
 * Ключ включает userId: на одном телефоне могут входить разные люди, и день
 * одного не должен применяться к другому. Значение — «сырая» дата YYYY.MM.DD
 * (тот же формат, что в расписании).
 */

const PREFIX = 'hub_last_day:';

export function readLastDay(userId: string): string | null {
  if (!userId) return null;
  try {
    return window.localStorage.getItem(PREFIX + userId);
  } catch {
    // Приватный режим или отключённое хранилище: работаем без запоминания дня.
    return null;
  }
}

export function writeLastDay(userId: string, rawDate: string): void {
  if (!userId) return;
  try {
    window.localStorage.setItem(PREFIX + userId, rawDate);
  } catch {
    // см. readLastDay
  }
}
