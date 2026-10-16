/**
 * Экран замеров для телефона.
 *
 * Открывается адресом вида …/?debug=1. Показывает то, что нужно увидеть прямо
 * на устройстве: частоту кадров, длинные задачи и версию сборки.
 *
 * Версия сборки в списке — не формальность. Service Worker кэширует оболочку,
 * и на телефоне легко месяц смотреть старую версию, не понимая, почему правки
 * не видны. Одна строка с меткой снимает этот вопрос сразу.
 */

import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';

import {
  buildStamp,
  fetchSwVersion,
  getDiagnostics,
  resetDiagnostics,
  startDiagnostics,
  subscribeDiagnostics,
  type Diagnostics,
} from '@/diagnostics';
import { readViewportMetrics, type ViewportMetrics } from '@/lib/viewport';

const EMPTY: Diagnostics = {
  fps: 0,
  fpsLast: 0,
  longTasksRecent: 0,
  worstLongTask: 0,
  busyPercent: 0,
  sampleCount: 0,
};

const NO_VIEWPORT: ViewportMetrics = {
  rootHeight: '—',
  rootTop: '—',
  rootBottom: '—',
  headerTop: '—',
  tabbarBottom: '—',
  rootMarginTop: '—',
  rootPaddingTop: '—',
  bodyPaddingTop: '—',
  htmlPaddingTop: '—',
  appHeight: '—',
  visualHeight: '—',
  visualOffsetTop: '—',
  innerHeight: '—',
  clientHeight: '—',
  screenHeight: '—',
  safeAreaBottom: '—',
  displayMode: '—',
  overhang: '—',
  bottomGap: '—',
  pagers: '—',
};

/** Цвет вердикта: ниже 45 fps — интерфейс дёргается, это видно глазом. */
function fpsVerdict(fps: number): { text: string; color: string } {
  if (fps >= 55) return { text: 'плавно', color: '#30d158' };
  if (fps >= 45) return { text: 'нормально', color: '#ffd60a' };
  if (fps >= 30) return { text: 'рвано', color: '#ff9f0a' };
  return { text: 'лаги', color: '#ff453a' };
}

export function DiagnosticsScreen({ onClose }: { onClose: () => void }) {
  const [d, setD] = useState<Diagnostics>(EMPTY);
  const [swVersion, setSwVersion] = useState('читаю…');
  const [vp, setVp] = useState<ViewportMetrics>(NO_VIEWPORT);

  useEffect(() => {
    startDiagnostics();
    const unsub = subscribeDiagnostics(() => setD(getDiagnostics()));

    // Версию воркера читаем один раз при открытии: она меняется только с
    // обновлением Service Worker, а запрос каждый раз был бы лишним.
    void fetchSwVersion().then(setSwVersion);

    return unsub;
  }, []);

  const verdict = fpsVerdict(d.fps);
  const bad = verdict.color === '#ff453a' || verdict.color === '#ff9f0a';

  // Пересчёт замеров вьюпорта по нажатию: без кнопки значения ездили бы сами
  // (панель Safari живёт своей жизнью), и в скриншоте попадал бы случайный
  // момент. Снимок делается в момент нажатия — это и нужно прислать.
  const [vpAt, setVpAt] = useState<string>('не снято');
  const shootViewport = () => {
    setVp(readViewportMetrics());
    setVpAt(new Date().toLocaleTimeString('ru-RU'));
  };

  return (
    <div
      className="min-h-full overflow-y-auto px-4 pb-10 pt-[max(16px,env(safe-area-inset-top))]"
      style={{ background: '#000', color: '#fff', font: '13px/1.45 ui-monospace, Menlo, monospace' }}
    >
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-[17px] font-bold">Замеры на устройстве</h1>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-3 py-1.5"
          style={{ background: '#1c1c1e' }}
        >
          Закрыть
        </button>
      </div>

      <p style={{ color: '#8e8e93' }} className="mb-4 text-[12px] leading-snug">
        Обнови страницу, потом листай расписание и переключай дни. Здесь появится,
        где именно теряется кадр. Скриншот этого экрана и есть ответ.
      </p>

      {/* Главная цифра — одна, крупно: её и нужно прислать. */}
      <div
        className="mb-3 rounded-2xl p-4"
        style={{ background: '#1c1c1e', border: `1px solid ${bad ? verdict.color : '#2c2c2e'}` }}
      >
        <div className="mb-1 text-[11px]" style={{ color: '#8e8e93' }}>
          КАДРОВ В СЕКУНДУ (среднее за 5 с)
        </div>
        <div className="text-[40px] leading-none font-bold" style={{ color: verdict.color }}>
          {d.fps.toFixed(1)}
        </div>
        <div className="mt-1 text-[13px]" style={{ color: verdict.color }}>
          {d.fps > 0 ? verdict.text : 'измеряю…'}
        </div>
      </div>

      <Row label="Кадров в последнюю секунду" value={String(d.fpsLast)} />
      <Row label="Длинных задач (>50 мс) за 5 с" value={String(d.longTasksRecent)} bad={d.longTasksRecent > 5} />
      <Row label="Худшая задача, мс" value={String(d.worstLongTask)} bad={d.worstLongTask > 150} />
      <Row label="Поток занят, % времени" value={`${d.busyPercent}%`} bad={d.busyPercent > 25} />
      <Row label="Замеров накоплено" value={String(d.sampleCount)} />

      <div
        className="mt-4 rounded-xl p-3 text-[12px] leading-snug"
        style={{ background: '#1c1c1e', color: '#8e8e93' }}
      >
        <div className="mb-1 font-bold" style={{ color: '#fff' }}>
          ВЬЮПОРТ (причина пустой полосы под меню)
        </div>
        <div>
          «--app-height» — что реально задано #root; «корень» — его вычисленная
          высота; «высота вьюпорта» — visualViewport.height, то есть ровно то,
          что видно во вкладке браузера. «Зазор до низа экрана» — главная
          цифра: это «низ #root» минус низ экрана. В установленном приложении
          (standalone) эталон снизу — window.screen.height, во вкладке —
          visualViewport. Ноль значит, что панель прижата к низу; положительное
          значение — чёрная полоса под панелью, отрицательное — панель уехала за
          низ экрана. Снимок сделан в {vpAt}.
        </div>
      </div>

      <button
        type="button"
        onClick={shootViewport}
        className="mt-2 w-full rounded-xl py-2.5"
        style={{ background: '#1c1c1e' }}
      >
        Снять замеры вьюпорта
      </button>

      <div className="mt-2 rounded-xl px-3" style={{ background: '#1c1c1e' }}>
        <Row label="Высота #root (вычисл.)" value={vp.rootHeight} />
        <Row label="Верх #root" value={vp.rootTop} />
        <Row label="Низ #root" value={vp.rootBottom} />
        <Row label="Верх шапки" value={vp.headerTop} />
        <Row label="Низ TabBar" value={vp.tabbarBottom} />
        <Row label="margin-top у #root" value={vp.rootMarginTop} />
        <Row label="padding-top: #root" value={vp.rootPaddingTop} />
        <Row label="padding-top: body" value={vp.bodyPaddingTop} />
        <Row label="padding-top: html" value={vp.htmlPaddingTop} />
        <Row label="Режим отображения" value={vp.displayMode} />
        <Row label="safe-area снизу" value={vp.safeAreaBottom} />
        <Row label="--app-height" value={vp.appHeight} />
        <Row label="Высота вьюпорта (visual)" value={vp.visualHeight} />
        <Row label="Смещение вьюпорта сверху" value={vp.visualOffsetTop} />
        <Row label="window.innerHeight" value={vp.innerHeight} />
        <Row label="documentElement.clientHeight" value={vp.clientHeight} />
        <Row label="window.screen.height" value={vp.screenHeight} />
        <Row
          label="Перебор низа (корень − вьюпорт)"
          value={vp.overhang}
          bad={vp.overhang !== '—' && parseFloat(vp.overhang) > 0.5}
        />
        <Row
          label="Зазор до низа экрана"
          value={vp.bottomGap}
          bad={Math.abs(parseFloat(vp.bottomGap) || 0) > 0.5}
        />
      </div>

      {/*
        Сводка по лентам. Значение многострочное, поэтому не Row: там одна
        строка «метка — значение», а здесь на каждый SwipePager своя строка с
        тремя числами.
      */}
      <div
        className="mt-2 rounded-xl p-3 text-[12px] leading-snug"
        style={{ background: '#1c1c1e', color: '#8e8e93' }}
      >
        <div className="mb-1 font-bold" style={{ color: '#fff' }}>
          ЛЕНТЫ (корень / трек / страница)
        </div>
        <div style={{ whiteSpace: 'pre-line' }}>{vp.pagers}</div>
        <div className="mt-2">
          Если «трек растянут», а сверху всё равно пусто — день просто короткий,
          и лечить тут нечего.
        </div>
      </div>

      <div
        className="mt-4 rounded-xl p-3 text-[12px] leading-snug"
        style={{ background: '#1c1c1e', color: '#8e8e93' }}
      >
        <div className="mb-1 font-bold" style={{ color: '#fff' }}>
          СБОРКА
        </div>
        <div>версия Service Worker: {swVersion}</div>
        <div>метка в бандле: {buildStamp()}</div>
        <div style={{ wordBreak: 'break-all' }}>адрес: {window.location.host}</div>
        <div>iOS: {isIOS() ? 'да' : 'нет'}</div>
        <div>память (если браузер отдаёт): {memoryMB() ?? 'недоступно'}</div>
      </div>

      <button
        type="button"
        onClick={resetDiagnostics}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl py-2.5"
        style={{ background: '#1c1c1e' }}
      >
        <RotateCcw size={14} />
        Сбросить замеры
      </button>

      <p className="mt-3 text-[12px] leading-snug" style={{ color: '#8e8e93' }}>
        «Длинных задач» много и «поток занят» большой — значит интерфейс
        считает что-то лишнее. Если задач нет, а кадров мало — значит тормозит
        не скрипт, а отрисовка (размытие, тени, анимация через GPU).
      </p>
    </div>
  );
}

function Row({ label, value, bad = false }: { label: string; value: string; bad?: boolean }) {
  return (
    <div
      className="flex items-center justify-between border-b py-2"
      style={{ borderColor: '#2c2c2e' }}
    >
      <span style={{ color: '#8e8e93' }}>{label}</span>
      <span style={{ color: bad ? '#ff9f0a' : '#fff' }}>{value}</span>
    </div>
  );
}

function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

/** performance.memory есть только в Chromium; на iPhone его нет. */
function memoryMB(): string | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? `${Math.round(m.usedJSHeapSize / 1048576)} МБ` : null;
}