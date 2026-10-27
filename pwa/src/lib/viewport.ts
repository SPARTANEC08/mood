/**
 * Высота корневого контейнера приложения.
 *
 * Задаётся одной величиной: --app-height, которую читает #root в index.css.
 * Всё остальное — браузерные единицы (100dvh) — служит запасным вариантом на
 * случай, если JS не выполнялся.
 *
 * ── Почему всё считается здесь, а не в CSS ──────────────────────────────────
 *
 * 1. Вкладка Safari на iPhone. Панель адреса и панель браузера НЕ меняют
 *    layout viewport, а накладываются поверх содержимого. Поэтому `vh`, `svh`,
 *    `lvh` и `dvh` считаются там от большого вьюпорта — от полного экрана
 *    вместе с областью под панелью. Ни одна CSS-величина не равна там
 *    видимой области; `visualViewport.height` — равна.
 *
 * 2. Установленное приложение (standalone) на iPhone — обратный случай, и
 *    именно он приносил чёрную полосу под нижней панелью. Панелей браузера
 *    нет, окно занимает весь экран, но Safari сообщает высоту окна БЕЗ нижней
 *    safe-area. Замер на устройстве:
 *
 *      window.innerHeight            = 793
 *      window.visualViewport.height  = 793
 *      window.screen.height          = 852
 *      getComputedStyle(#root).height = "793px"
 *
 *    Разница 852 − 793 = 59px — это нижняя safe-area (домашний индикатор и
 *    закругление). #root заканчивался на 59px выше физического низа экрана, а
 *    TabBar прижат к низу корзины по построению — значит, под ним оставалась
 *    полоса. В тёмной теме это фон приложения (--app-bg), то есть ровно
 *    чёрная полоса.
 *
 *    Отсюда две поправки, обе — только для standalone:
 *
 *    - брать максимум из visualViewport.height, innerHeight и clientHeight
 *      (все три могут расходиться между собой и с CSS-вьюпортом), а не
 *      только visualViewport;
 *    - на iPhone, если `env(safe-area-inset-bottom)` ненулевой, брать также
 *      максимум с `screen.height`. Ненулевой inset — это и есть доказательство,
 *      что окно накрывает область под индикатором: раз так, то площадь под
 *      индикатором наша, и исключать её из высоты незачем.
 *      В iPad/на телефонах без выреза inset нулевой, и лишней высоты не
 *      добавляется.
 *
 * ── Почему это не опрос раз в секунду ───────────────────────────────────────
 *
 * Таймера нет. Значение пересчитывается только по событиям, которые браузер
 * и так рассылает при изменении вьюпорта: resize визуального вьюпорта, resize
 * окна, поворот экрана. Единственное чтение раскладки — probe-элемент для
 * safe-area, и он тоже выполняется только в этих обработчиках.
 * События visual viewport во время анимации панели Safari идут пачками, поэтому
 * resize визуального вьюпорта дебаунсится; resize окна и поворот экрана
 * применяются сразу, иначе первый кадр после поворота рисуется по старой
 * высоте.
 */

/** Имя CSS-переменной, в которую кладется высота. Дублируется в index.css. */
export const APP_HEIGHT_VAR = '--app-height';

/** Пауза перед применением после события visual viewport, мс. */
const RESIZE_DEBOUNCE_MS = 120;

/** Период опроса высоты в standalone на iOS, мс. */
const STANDALONE_POLL_MS = 500;

/**
 * Probe-элемент для чтения env(safe-area-inset-bottom).
 *
 * Из JS нельзя спросить safe-area напрямую, а CSS-функция env() читается
 * только в стилях. Поэтому один невидимый элемент с
 * `padding-bottom: env(safe-area-inset-bottom)` и чтение его вычисленного
 * padding. Элемент создаётся один раз и ничего не занимает: position fixed,
 * нулевые размеры, visibility hidden. Он не влияет на раскладку и не
 * перерисовывается сам по себе.
 */
let safeAreaProbe: HTMLElement | null = null;

function safeAreaInsetBottom(): number {
  if (typeof document === 'undefined' || !document.body) return 0;
  if (!safeAreaProbe) {
    const probe = document.createElement('div');
    probe.style.cssText = [
      'position:fixed',
      'left:0',
      'bottom:0',
      'width:0',
      'height:0',
      'visibility:hidden',
      'pointer-events:none',
      'padding-bottom:env(safe-area-inset-bottom, 0px)',
    ].join(';');
    document.body.appendChild(probe);
    safeAreaProbe = probe;
  }
  const value = Number.parseFloat(getComputedStyle(safeAreaProbe).paddingBottom);
  return Number.isFinite(value) ? value : 0;
}

/**
 * iOS, включая iPadOS, который в User-Agent представляется как «MacIntel».
 *
 * Проверка нужна только для поправки со screen.height: она верна лишь там, где
 * браузер систематически исключает safe-area из высоты окна.
 */
function isIos(): boolean {
  const nav = window.navigator;
  if (/iPad|iPhone|iPod/.test(nav.userAgent)) return true;
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1;
}

/** Режим отображения: установленное приложение или вкладка браузера. */
export function displayMode(): 'standalone' | 'fullscreen' | 'browser' {
  // navigator.standalone ПЕРВЫМ: на iOS медиазапрос (display-mode: …) не
  // поддерживается, и проверка только через matchMedia там всегда давала
  // `browser` — то есть приложение, запущенное с иконки, считалось вкладкой.
  if ((window.navigator as Navigator & { standalone?: boolean }).standalone === true) {
    return 'standalone';
  }

  if (typeof window.matchMedia !== 'function') return 'browser';
  if (window.matchMedia('(display-mode: standalone)').matches) return 'standalone';
  if (window.matchMedia('(display-mode: fullscreen)').matches) return 'fullscreen';

  return 'browser';
}

/** Панелей браузера нет — виден весь экран. */
function isFullscreenDisplay(): boolean {
  const mode = displayMode();
  return mode === 'standalone' || mode === 'fullscreen';
}

/**
 * Метка «приложение запущено с иконки» на элементе <html>.
 *
 * CSS не может прочитать navigator.standalone, а медиазапрос
 * `(display-mode: standalone)` на iOS НЕ ПОДДЕРЖИВАЕТСЯ вовсе — там режим
 * сообщается только через navigator.standalone. Из-за этого CSS-ветка для
 * standalone не срабатывала никогда, и корзина оставалась на высоте вьюпорта
 * без нижней safe-area: под панелью появлялась чёрная полоса.
 *
 * Поэтому режим вычисляется здесь и кладётся в data-атрибут, а CSS смотрит
 * уже на него. Дублирующая проверка через медиазапрос остаётся: на Android и
 * десктопе он работает, а navigator.standalone там не существует.
 */
const STANDALONE_ATTR = 'data-mood-standalone';

function detectStandalone(): boolean {
  if ((window.navigator as Navigator & { standalone?: boolean }).standalone === true) return true;

  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
  }

  return false;
}

function syncStandaloneAttr(): void {
  const root = document.documentElement;
  if (!root) return;

  if (detectStandalone()) root.setAttribute(STANDALONE_ATTR, '');
  else root.removeAttribute(STANDALONE_ATTR);
}

/**
 * Высота, которую получает #root.
 *
 * Две ветки, и различие между ними принципиально:
 *
 * - вкладка браузера — только visual viewport. innerHeight и clientHeight там
 *   БОЛЬШЕ видимой области (панель Safari наложена, а не вычтена), и maxima из
 *   них утащили бы нижнюю панель под панель браузера. Это ровно то, ради чего
 *   раньше всё и писалось в JS;
 * - standalone — максимум из всех источников плюс, на iPhone с ненулевым
 *   нижним inset, максимум с screen.height. Подробности в шапке модуля.
 */
function currentHeight(): number {
  const visual = window.visualViewport?.height ?? 0;
  const inner = window.innerHeight;
  const client = document.documentElement.clientHeight;

  if (!isFullscreenDisplay()) return visual > 0 ? visual : inner;

  // Android standalone: visualViewport и есть видимая область. max(inner,
  // client) здесь опасен — после reload системная навигация может на время
  // отчитаться иначе, и #root становится выше экрана: TabBar уезжает за низ.
  // Если visual ещё не готов, берём меньшую из запасных величин.
  if (!isIos()) {
    if (visual > 0) return visual;
    if (inner > 0 && client > 0) return Math.min(inner, client);
    return Math.max(inner, client);
  }

  // iOS standalone: окно сообщает высоту без нижней safe-area, поэтому берём
  // максимум и при ненулевом inset — физическую высоту экрана.
  let height = Math.max(visual, inner, client);

  if (safeAreaInsetBottom() > 0) {
    height = Math.max(height, window.screen.height);
  }

  return height;
}

function apply(): void {
  syncStandaloneAttr();
  document.documentElement.style.setProperty(APP_HEIGHT_VAR, `${Math.round(currentHeight())}px`);
}

/**
 * Периодический пересчёт в standalone на iOS.
 *
 * Отдельные события resize тут не помогают: при появлении home-индикатора или
 * при возврате приложения из фона высота окна меняется, а событие не
 * приходит. Без этого пересчёта переменная остаётся со значением, взятым при
 * запуске, и корзина стоит на старой высоте.
 *
 * Опрос включается ТОЛЬКО в standalone на iOS и снимается, как только режим
 * перестал быть standalone: во вкладке браузера он был бы лишним чтением
 * раскладки каждые полсекунды.
 */
let pollTimer: ReturnType<typeof setInterval> | undefined;

function syncStandalonePolling(): void {
  const needed = isFullscreenDisplay() && isIos();

  if (needed && pollTimer === undefined) {
    pollTimer = setInterval(() => {
      if (!document.hidden) apply();
    }, STANDALONE_POLL_MS);
  } else if (!needed && pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

let resizeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Пересчёт с задержкой.
 *
 * События visual viewport во время сворачивания панели Safari приходят пачками
 * (несколько кадров анимации подряд), и на каждый вызов пришлось бы заново
 * читать стили probe-элемента.
 */
function applyDebounced(): void {
  if (resizeTimer !== undefined) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = undefined;
    apply();
  }, RESIZE_DEBOUNCE_MS);
}

let bound = false;

/**
 * Начать отслеживать высоту вьюпорта. Вызывается один раз, до первого рендера.
 *
 * Порядок подписки: сначала применяем текущее значение, потом вешаем
 * обработчики. Иначе между этими двумя шагами пролетает кадр без переменной.
 *
 * Повторный вызов ничего не делает: иначе страница, смонтированная второй раз
 * (StrictMode, горячая перезагрузка), получила бы вдвое больше обработчиков.
 */
export function bindViewportHeight(): void {
  if (typeof window === 'undefined' || bound) return;
  bound = true;

  apply();
  syncStandalonePolling();

  const vv = window.visualViewport;
  // scroll нужен для случая, когда панель браузера не меняет высоту, а сдвигает
  // вьюпорт: высота та же, но начало координат плывёт. Без него корзина
  // «залипает» на пару кадров при возврате со скролла в начало.
  vv?.addEventListener('resize', applyDebounced);
  vv?.addEventListener('scroll', apply);
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);

  // После обновления PWA страница может получить готовую раскладку без
  // события resize. Пересчитываем на pageshow/load и ещё раз чуть позже, когда
  // системные панели Android/iOS уже заняли своё место.
  window.addEventListener('pageshow', apply);
  window.addEventListener('load', apply);
  window.setTimeout(apply, 250);
  window.setTimeout(apply, 1200);

  // Приложение могло быть свёрнуто в вкладку и запущено с иконки — режим
  // меняется без перезагрузки, и подписки на resize в этом случае не будет.
  document.addEventListener('visibilitychange', onVisibilityChange);
}

/**
 * Возврат приложения из фона.
 *
 * В standalone iOS это единственный момент, когда стоит пересчитать высоту и
 * пересмотреть режим: человек мог вернуться уже из другой вкладки.
 */
function onVisibilityChange(): void {
  if (document.visibilityState !== 'visible') return;

  syncStandaloneAttr();
  syncStandalonePolling();
  apply();
}

/** Замеры для экрана ?debug=1 — ровно те числа, по которым ставится диагноз. */
export interface ViewportMetrics {
  /** Высота, заданная в #root (вычисленная, не заявленная). */
  rootHeight: string;
  /** Положение верхней грани #root относительно видимой области, px. */
  rootTop: string;
  /** Нижняя грань #root, px. Сравнивается с window.screen.height. */
  rootBottom: string;
  /** Положение верхней грани шапки страницы, px. */
  headerTop: string;
  /** Положение нижней грани панели навигации, px. */
  tabbarBottom: string;
  /** Вычисленный margin-top у #root — показывает, сработал ли сдвиг. */
  rootMarginTop: string;
  /** Вычисленный padding-top у #root. */
  rootPaddingTop: string;
  /** Вычисленный padding-top у body. */
  bodyPaddingTop: string;
  /** Вычисленный padding-top у html. */
  htmlPaddingTop: string;
  /** Значение --app-height, которым сейчас живёт #root. */
  appHeight: string;
  /** visualViewport.height — истина на iOS во вкладке. */
  visualHeight: string;
  /** Смещение начала visual viewport, px. */
  visualOffsetTop: string;
  /** window.innerHeight. */
  innerHeight: string;
  /** documentElement.clientHeight — layout viewport минус прокрутка. */
  clientHeight: string;
  /** window.screen.height — физический экран в CSS-пикселях. */
  screenHeight: string;
  /** env(safe-area-inset-bottom), px. */
  safeAreaBottom: string;
  /** Режим отображения: standalone, fullscreen или browser. */
  displayMode: string;
  /** Насколько корзина длиннее видимой области, px. Положительное = полоса внизу. */
  overhang: string;
  /**
   * Главная цифра после правки: низ #root минус низ экрана, px.
   *
   * Ноль означает, что панель прижата к физическому низу. Положительное
   * значение — чёрная полоса под панелью (корзина не дотянула до низа),
   * отрицательное — панель уехала за низ экрана (вкладка Safari, где low
   * viewport меньше видимой области).
   */
  bottomGap: string;
  /**
   * Сводка по всем SwipePager на экране: их корень, трек и самая высокая страница.
   *
   * Нужна, чтобы отличить «трек не растянут и под ним пустота» от «трек растянут,
   * а день просто короткий». Сравнение trackHeight с rootHeight отвечает на
   * вопрос о flex-высоте, не требуя правок в Pager.tsx.
   */
  pagers: string;
}

function px(value: number): string {
  return `${Math.round(value)}px`;
}

/**
 * Собрать замеры. ВНИМАНИЕ: читает computed style #root, то есть вызывает
 * пересчёт раскладки. Это допустимо только на экране отладки — в рантайме
 * приложения таких чтений нет.
 */
export function readViewportMetrics(): ViewportMetrics {
  const root = document.getElementById('root');
  const vv = window.visualViewport;
  const visual = vv ? vv.height : window.innerHeight;

  const rootRect = root ? root.getBoundingClientRect() : { height: 0, top: 0, bottom: 0 };
  const appHeight = getComputedStyle(document.documentElement).getPropertyValue(APP_HEIGHT_VAR).trim();

  // Положение шапки и панели нужно для главного вопроса «откуда сдвиг»: если
  // headerTop дробный, виноват не #root, а что-то внутри — например
  // env(safe-area-inset-top), который на части устройств отдаётся дробным.
  const header = document.querySelector('header');
  const tabbar = document.querySelector('[role="tablist"]');

  const mode = displayMode();
  const inset = safeAreaInsetBottom();
  const standaloneFullscreen = mode === 'standalone' || mode === 'fullscreen';

  // Низ, до которого корзина обязана дотягиваться. В standalone с ненулевым
  // нижним inset окно накрывает весь экран, и эталоном служит screen.height;
  // во всех остальных случаях — низ видимой области.
  const referenceHeight =
    standaloneFullscreen && inset > 0 ? Math.max(visual, window.screen.height) : visual;
  const referenceBottom = rootRect.top + referenceHeight;

  return {
    rootHeight: px(rootRect.height),
    rootTop: px(rootRect.top),
    rootBottom: px(rootRect.bottom),
    headerTop: header ? px(header.getBoundingClientRect().top) : 'нет шапки',
    tabbarBottom: tabbar ? px(tabbar.getBoundingClientRect().bottom) : 'нет панели',
    rootMarginTop: root ? getComputedStyle(root).marginTop : '—',
    rootPaddingTop: root ? getComputedStyle(root).paddingTop : '—',
    bodyPaddingTop: getComputedStyle(document.body).paddingTop,
    htmlPaddingTop: getComputedStyle(document.documentElement).paddingTop,
    appHeight: appHeight || 'не задана',
    visualHeight: px(visual),
    visualOffsetTop: vv ? px(vv.offsetTop) : 'нет visualViewport',
    innerHeight: px(window.innerHeight),
    clientHeight: px(document.documentElement.clientHeight),
    screenHeight: px(window.screen.height),
    safeAreaBottom: px(inset),
    displayMode: mode,
    overhang: px(rootRect.height - visual),
    bottomGap: px(rootRect.bottom - referenceBottom),
    pagers: readPagers(),
  };
}

/**
 * Сводка по SwipePager.
 *
 * Селектор `.touch-pan-y` принадлежит только корню SwipePager (Pager.tsx) —
 * больше его нигде нет, поэтому на экране расписания находятся ровно два:
 * полоса недель и лента дней. Считается по порядку в DOM.
 *
 * Ключевое сравнение — `root` против `track`. Если они равны, трек растянут на
 * всю высоту корня и пустоты под ним быть не может: значит пустое место на
 * экране — это просто короткий день, а не дефект раскладки.
 */
function readPagers(): string {
  const roots = Array.from(document.querySelectorAll<HTMLElement>('.touch-pan-y'));

  if (roots.length === 0) return 'нет на экране';

  return roots
    .map((rootEl, index) => {
      const track = rootEl.firstElementChild as HTMLElement | null;
      const rootH = Math.round(rootEl.getBoundingClientRect().height);
      const trackH = track ? Math.round(track.getBoundingClientRect().height) : 0;

      // Самая высокая страница внутри трека: если она выше трека, день
      // переполняется и не помещается — это другой симптом, чем пустота.
      const tallestPage = track
        ? Math.max(
            0,
            ...Array.from(track.children).map((page) =>
              Math.round(page.getBoundingClientRect().height),
            ),
          )
        : 0;

      const stretched = rootH - trackH;
      const verdict = stretched <= 0 ? 'трек растянут' : `трек короче корня на ${stretched}px`;

      return `#${index} (${index === 0 ? 'недели' : 'дни'}): корень ${rootH}px, трек ${trackH}px, страница до ${tallestPage}px — ${verdict}`;
    })
    .join('\n');
}