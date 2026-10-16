/**
 * Форматирование дат для интерфейса.
 *
 * Почему это отдельный файл, а не пара функций в каждой странице: месяцы и
 * разбор даты нужны и списку, и детальному экрану, и карточке предмета, а
 * копия одного и того же разбора в пяти местах рано или поздно разъезжается —
 * уже разъезжалась (массив месяцев повторялся в пяти файлах).
 *
 * Главная тонкость — два разных формата на входе:
 *
 * - `targetDate` приходит из расписания строкой `YYYY.MM.DD` («2099.10.14»).
 *   Это НЕ дата JS: `new Date('2099.10.14')` в Safari толкуется как 14 октября
 *   или как 13-е в зависимости от зоны, а в Node вообще может дать Invalid Date.
 *   Поэтому такая строка разбирается руками;
 * - `createdAt` приходит из базы как полный ISO (`2026-10-12T09:15:00.000Z`) и
 *   разбирается штатно.
 *
 * На неразбираемое значение возвращается исходная строка: показать «Invalid
 * Date» или пустоту хуже, чем показать то, что прислал сервер.
 */

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/**
 * Дата задания из расписания: «YYYY.MM.DD» → «14 окт».
 *
 * Для ISO-строки тоже работает — на случай, если сервер когда-нибудь поменяет
 * формат, а интерфейс уже нет.
 */
export function formatTargetDate(value: string): string {
  const raw = (value ?? '').trim();

  const dotted = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(raw);
  if (dotted) {
    const monthIndex = Number(dotted[2]) - 1;
    if (monthIndex < 0 || monthIndex > 11) return raw;

    return `${Number(dotted[3])} ${MONTHS[monthIndex]}`;
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/**
 * Дата создания записи: ISO → «9 окт» или «9 окт, 14:30» со временем.
 *
 * Время показывается только если его есть в строке: у объявления из базы оно
 * всегда есть, а вот если сервер когда-нибудь пришлёт дату без времени,
 * дописывать «, 00:00» значило бы показывать выдуманную точность.
 */
export function formatCreatedAt(value: string, withTime = false): string {
  const raw = (value ?? '').trim();
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  if (!withTime) return day;

  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${day}, ${time}`;
}

/** Склонение по числу: plural(1, 'пара') → «пара», plural(3, 'пара') → «пары». */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;

  return many;
}

/**
 * «YYYY.MM.DD» → Date в UTC.
 *
 * Именно UTC, а не локальная зона: дата приходит как календарная, и `new Date`
 * в Safari разобрал бы её иначе (см. комментарий к formatTargetDate). Все
 * сравнения и арифметика дня идут через getUTCDate/setUTCDate — так результат
 * одинаков на любом устройстве. Вызывающий код обязан использовать UTC-методы.
 */
export function parseRawDate(raw: string): Date | null {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(raw);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Date (в UTC) → «YYYY.MM.DD» — обратная к parseRawDate. */
export function formatRawDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}
