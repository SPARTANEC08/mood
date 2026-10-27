import { CalendarDays, ChartNoAxesColumn, NotebookPen, Plus, UserRound, type LucideIcon } from 'lucide-react';

import { NotificationBell } from '@/components/notifications/NotificationBell';
import { cn } from '@/lib/cn';
import { haptic } from '@/lib/env';

export type TabId = 'schedule' | 'grades' | 'tasks' | 'profile';

export interface TabDef {
  id: TabId;
  label: string;
  icon: LucideIcon;
}

/**
 * Порядок кнопок в панели, а не набор вкладок.
 *
 * Пятый элемент — плюсик, и он НЕ является вкладкой: `TabId` по-прежнему из
 * четырёх значений, а активной остаётся вкладка, на которой человек был.
 * Добавить сюда пятое значение означало бы завести состояние, которого нет
 * ни на одной странице, и подсветку несуществующего экрана.
 */
export const TAB_BUTTONS: Array<TabDef | { id: 'add'; label: string; icon: LucideIcon }> = [
  { id: 'schedule', label: 'Расписание', icon: CalendarDays },
  { id: 'grades', label: 'Успеваемость', icon: ChartNoAxesColumn },
  { id: 'add', label: 'Добавить', icon: Plus },
  { id: 'tasks', label: 'Задания', icon: NotebookPen },
  { id: 'profile', label: 'Кабинет', icon: UserRound },
];

/**
 * Нижняя навигация в стиле iOS TabBar.
 *
 * ── Почему панель живёт В ПОТОКЕ, а не position: fixed ──────────────────────
 *
 * Коротко: `fixed` на iPhone считает низ от LAYOUT viewport, а он больше
 * VISUAL — включает зону под панелью Safari и под домашней индикацией.
 * Панель на `fixed inset-x-0 bottom-0` оказывалась НИЖЕ видимой области:
 * в обычной вкладке Safari её срезала нижняя панель браузера, и под
 * меню оставалась пустая полоса. Ровно это описано в index.css (раздел про
 * --app-height) и в lib/viewport.ts: на iOS не существует CSS-величины,
 * которая считала бы низ от visual viewport, поэтому высоту корзины приходится
 * задавать из JS.
 *
 * Так вот: такая корзина уже есть. Это #root — `height: var(--app-height)`,
 * где --app-height равен visualViewport.height и обновляется по событиям
 * visual viewport (lib/viewport.ts). Её низ и есть видимый низ экрана, и она
 * не зависит ни от длины ленты, ни от адресной строки, ни от клавиатуры.
 *
 * Панель поэтому стоит последним flex-ребёнком этой колонки: контент выше
 * растягивается на `flex: 1`, панель — `shrink-0`, и прижата к низу обычной
 * раскладкой. Нижний край получается правильным по построению, а не подгонкой.
 *
 * Следствия, которые важно не забыть при следующей правке:
 *
 * - панель НЕ выносится из потока, поэтому спейсер, возвращавший колонке место
 *   после ухода на fixed, больше не нужен: панель по-прежнему занимает своё
 *   место в потоке и сама отодвигает ленту. Скролл-область заканчивается там,
 *   где начинается панель, поэтому последняя карточка под неё не уезжает и без
 *   padding-bottom;
 * - `height: var(--tabbar-height)` с border-box (его ставит preflight Tailwind)
 *   делает ВНЕШНЮЮ высоту панели ровно равной переменной: рамка border-top и
 *   отступ под home-индикатор съедают её изнутри, а не добавляют сверху. Иначе
 *   панель была бы на пиксель выше объявленной высоты, и плавающие тосты над
 *   лентой ( SchedulePage / TasksPage, `bottom: calc(var(--tabbar-height) + 12px)` )
 *   наезжали бы на неё;
 * - отступ под домашнюю индикацию задаётся прямо в CSS через
 *   env(safe-area-inset-bottom). Раньше значение вычислялось в JavaScript с опросом
 *   раз в секунду: это и лишняя работа, и главный источник рывка — при каждой
 *   проверке вызывался getBoundingClientRect, то есть принудительная
 *   перерисовка раскладки. Браузер и так пересчитывает inset сам;
 * - этот отступ НЕ дублируется в #root (см. index.css): иначе корзина стала бы
 *   выше на величину inset, панель уехала бы вверх, а под ней открылась бы
 *   полоса фона — ровно тот дефект, который эта правка устраняет. Отступ под
 *   индикатор живёт в панели и больше нигде;
 * - активная иконка заливается accent, не меняет размер: смена толщины при
 *   тапе дёргает рядом стоящие элементы;
 * - подпись показывается только у активной вкладки — так меньше визуального
 *   шума, при этом активная вкладка узнаётся мгновенно.
 */
export function TabBar({
  active,
  onChange,
  onAdd,
  badges,
}: {
  active: TabId;
  onChange: (id: TabId) => void;
  /** Нажатие плюсика: открывает диалог добавления, вкладку не меняет. */
  onAdd: () => void;
  /** Счётчики на иконках, например непрочитанные письма. */
  badges?: Partial<Record<TabId, number>>;
}) {
  return (
    <nav
      role="tablist"
      aria-label="Навигация"
      // shrink-0: панель не сжимается, даже если колонке #root не хватило бы
      // места — растягиваться и уезжать вверх она не должна ни при каком
      // содержимом.
      className="shrink-0 border-t"
      // Полупрозрачная подложка, а не цвет страницы.
      //
      // Раньше здесь стоял `var(--app-bg)` — тот же цвет, что и фон приложения,
      // и на iPhone с домашней индикацией это читалось как «панель не доехала до
      // низа»: нижние 34px панели — это обязательный отступ под safe-area, но на
      // однотонном фоне они неотличимы от пустого места страницы.
      //
      // Замер на iPhone это подтвердил: низ панели равен низу видимой области
      // ровно (зазор 0px), barHeight = 90px при paddingBottom = 34px. То есть
      // править тут нечего — можно только сделать так, чтобы вся высота панели
      // выглядела одной поверхностью.
      //
      // Значение то же, что у навбара, и только фон: `backdrop-filter` не
      // возвращаем. Размытие подложки в WebKit — не дешёвая операция: при каждом
      // кадре прокрутки Safari заново сэмплирует всё, что под панелью, и
      // пересобирает композитный слой. В Chrome это почти бесплатно, поэтому на
      // десктопных замерах эффект не виден, а на слабом телефоне панель
      // подтормаживает. Полупрозрачности без размытия достаточно, чтобы панель
      // отличалась от фона.
      style={{
        // Внешняя высота = ровно --tabbar-height, см. описание выше.
        height: 'var(--tabbar-height)',
        background: 'var(--surface-blur)',
        borderColor: 'var(--separator-soft)',
// Нижняя граница 8px сохраняет прежний зазор для подписей на
        // устройствах без safe-area, а на iPhone индикатор физически лежит
        // под панелью, и подписи должны его обходить.
        paddingBottom: 'max(8px, env(safe-area-inset-bottom))',
        // Нижний отступ панели — ВЫСОТА панели вместе с зарядом под home-
        // индикатор. Никакого marginBottom: в потоке #root он поднял бы панель
        // над низом корзины и оставил под ней полосу фона, то есть ту самую
        // чёрную полосу, ради которой всё здесь и переписано. Низ панели
        // обязан совпадать с низом корзины по построению.
        marginBottom: 0,
      }}
    >
      {/*
        `h-full`, а не фиксированная высота: строка занимает всю высоту коробки
        панели, из которой border-top и padding-bottom уже вычли своё. Задавать
        здесь число в пикселях нельзя — вместе с рамкой и отступом панель стала
        бы на пиксель выше --tabbar-height, и плавающие тосты над лентой
        ( SchedulePage / TasksPage, `bottom: calc(var(--tabbar-height) + 12px)` )
        наезжали бы на неё.

        Круг плюсика центрируется в этой же строке, БЕЗ отрицательного отступа.
        Отступ `-mt-3` поднимал круг над верхней гранью панели: он налезал на
        содержимое ленты, а подписи соседних вкладок при этом оставались внизу
        строки — панель читалась как сдвинутая вверх, и на iPhone с вырезом
        подписи вставали на дробный пиксель и выглядели размытыми.
      */}
      <div className="mx-auto flex h-full max-w-[560px] items-stretch justify-around px-1">
        {TAB_BUTTONS.map((tab) => {
          const Icon = tab.icon;

          // ── Плюсик ────────────────────────────────────────────────────────
          if (tab.id === 'add') {
            return (
              <button
                key="add"
                type="button"
                // Имя отличается от подписи вкладок намеренно: у «Добавить» в
                // этом же экране есть кнопка в форме, и одинаковые имена
                // означали бы для скринридера две неразличимые кнопки.
                aria-label="Добавить задание или объявление"
                onClick={() => {
                  haptic('medium');
                  onAdd();
                }}
                className="pressable relative flex flex-1 items-center justify-center active:pressable-active"
              >
                {/*
                  36px против 23px у иконок вкладок — круг читается как главное
                  действие, но остаётся в строке и ничего не перекрывает.

                  Раньше круг был 48px при высоте строки 56px: на iPhone он
                  выпирал по вертикали и «раздувал» всю панель, рядом с ним
                  подписи соседних вкладок выглядели мелкими. 36px в строке
                  50px даёт по 7px воздуха сверху и снизу — круг по-прежнему
                  помещается целиком, панель при этом стала ниже.

                  Иконка уменьшена с 26 до 20 по той же причине, а strokeWidth
                  оставлен: на маленьком круге тонкий плюс читается как
                  «выключено», а не как действие.
                */}
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-full"
                  style={{
                    background: 'var(--accent)',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.14)',
                  }}
                >
                  <Icon size={20} strokeWidth={2.4} color="var(--accent-text)" aria-hidden />
                </span>
              </button>
            );
          }

          const isActive = tab.id === active;
          const badge = badges?.[tab.id];

          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-label={tab.label}
              onClick={() => {
                if (!isActive) haptic('light');
                onChange(tab.id);
              }}
              className="pressable relative flex flex-1 flex-col items-center justify-center gap-0.5 active:pressable-active"
            >
              <span className="relative">
                <Icon
                  size={23}
                  strokeWidth={isActive ? 2.2 : 1.9}
                  style={{ color: isActive ? 'var(--accent)' : 'var(--text-tertiary)' }}
                  aria-hidden
                />

                {badge && badge > 0 ? (
                  <span
                    className="absolute -top-1 -right-2.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white"
                    style={{ background: 'var(--accent)' }}
                  >
                    {badge > 99 ? '99+' : badge}
                  </span>
                ) : null}
              </span>

              <span
                className="text-[10px] leading-tight font-medium transition-opacity duration-150"
                style={{
                  color: isActive ? 'var(--accent)' : 'var(--text-tertiary)',
                  opacity: isActive ? 1 : 0,
                }}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * Верхняя шапка страницы.
 *
 * Шапка стоит в колонке приложения выше прокручиваемой ленты и не является
 * sticky: прокручивается только содержимое. Липкая шапка в WebKit — источник
 * артефактов (полосы и мигание при прокрутке), потому что Safari держит
 * sticky-элемент в отдельном compositing-слое и пересобирает его на каждом
 * кадре прокрутки. На слабом устройстве это выглядит как «шапка дёргается».
 *
 * ВЕРХНИЙ safe-area здесь НЕ задаётся и добавлять его нельзя: он живёт на
 * `#root` как `padding-top: env(safe-area-inset-top)` (см. index.css). Свой
 * inset здесь дал бы двойной отступ — шапка уехала бы вниз на величину
 * выреза. `large` теперь влияет только на размер заголовка.
 */
export function Header({
  title,
  large,
  right,
  subtitle,
  kicker,
}: {
  title: string;
  /** Крупный заголовок в стиле iOS Large Title. */
  large?: boolean;
  subtitle?: string;
  right?: React.ReactNode;
  /** Маленькая надпись над крупным заголовком, например «Личный кабинет». */
  kicker?: string;
}) {
  return (
    <header
      className={cn('shrink-0 px-4', large ? 'pb-3 pt-3' : 'py-3')}
      style={{ background: 'var(--app-bg)' }}
    >
      <div className="mx-auto flex max-w-[560px] items-center justify-between gap-3">
        <div className="min-w-0">
          {kicker ? (
            <p
              className="mb-0.5 truncate text-[11px] font-semibold uppercase tracking-[0.1em]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {kicker}
            </p>
          ) : null}
          <h1 className={cn('truncate font-semibold tracking-tight', large ? 'text-[30px] leading-tight' : 'text-[17px]')}>
            {title}
          </h1>
          {subtitle ? (
            <p className="truncate text-[13px] text-[var(--text-secondary)]">{subtitle}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {right}
          {/*
            Колокольчик стоит последним во всех шапках: у расписания он
            оказывается справа от «Сегодня» и календаря, у остальных вкладок —
            рядом с индикатором обновления. Сам компонент решает, рисоваться ли
            ему: на экране входа провайдера нет.
          */}
          <NotificationBell />
        </div>
      </div>
    </header>
  );
}