/**
 * Автономный HTML-отчёт: статичный «срез» страницы /dev/ на момент формирования.
 *
 * Повторяет дизайн и состав блоков самой страницы (тёмная тема, фиолетовый
 * акцент, все карточки/графики), но без JS — все графики уже нарисованы в SVG,
 * поэтому файл открывается сам по себе, без хостинга и сети.
 *
 * Источник данных — тот же `getStats()`, что отдаёт странице, поэтому отчёт и
 * сайт всегда выглядят одинаково.
 */

import type { StatsResponse } from '../../server/devStats.ts';

const ACCENT = '#8b5cf6';
const ACCENT_LIGHT = '#a78bfa';
const ACCENT_DARK = '#6d28d9';
const ACCENT_LINE = '#c4b5fd';
const GOOD = '#34d399';
const DANGER = '#f87171';
const MUTED = '#8b8b9c';
const BORDER = '#2a2a36';
const GRID = '#2a2a36';
const DONUT_COLORS = ['#8b5cf6', '#a78bfa', '#7c3aed', '#c4b5fd', '#6d28d9', '#4c1d95'];

const CAT_LABELS: Record<string, string> = {
  schedule: 'Расписание',
  homework: 'Задания',
  important: 'Важное',
  bars: 'Оценки',
  mail: 'Почта',
  files: 'Файлы',
  bootstrap: 'Запуск',
  notifications: 'Уведомления',
  auth: 'Вход',
  other: 'Прочее',
};

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDay(day: string): string {
  const p = String(day).split('.');
  return p.length === 3 ? `${p[2]}.${p[1]}` : day;
}

function bytes(b: number): string {
  if (!b) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function rel(ts: number | null, now: number): string {
  if (!ts) return '—';
  const d = now - ts;
  if (d < 60_000) return 'только что';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} мин назад`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} ч назад`;
  return `${Math.floor(d / 86_400_000)} дн назад`;
}

// ── Кирпичики ────────────────────────────────────────────────────────────────

function kpi(label: string, value: string | number, hint = ''): string {
  return `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="hint">${hint}</div></div>`;
}

function lineChart(points: { label: string; value: number }[]): string {
  const W = 780;
  const H = 200;
  const padL = 34;
  const padR = 12;
  const padT = 14;
  const padB = 24;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const n = points.length || 1;
  const max = Math.max(1, ...points.map((p) => p.value));
  const x = (i: number): number => padL + (n <= 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (v: number): number => padT + ih - (v / max) * ih;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)} ${(padT + ih).toFixed(1)} L${x(0).toFixed(1)} ${(padT + ih).toFixed(1)} Z`;

  let grid = '';
  for (let g = 0; g <= 4; g += 1) {
    const gy = padT + (ih * g) / 4;
    grid += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="${GRID}"/>`;
    grid += `<text x="${padL - 6}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="${MUTED}">${Math.round((max * (4 - g)) / 4)}</text>`;
  }

  const step = Math.max(1, Math.ceil(n / 6));
  let labels = '';
  points.forEach((p, i) => {
    if (i % step === 0 || i === n - 1) {
      labels += `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="${MUTED}">${esc(fmtDay(p.label))}</text>`;
    }
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="width:100%;height:auto" role="img">` +
    `<defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.28"/><stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/></linearGradient></defs>` +
    grid +
    `<path d="${area}" fill="url(#area)"/>` +
    `<polyline points="${points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linejoin="round"/>` +
    labels +
    `</svg>`
  );
}

function barChart(values: number[], labels: string[]): string {
  const W = 780;
  const H = 180;
  const padL = 30;
  const padR = 10;
  const padT = 10;
  const padB = 24;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const max = Math.max(1, ...values, 1);
  const bw = iw / Math.max(1, values.length);
  const step = Math.max(1, Math.ceil(values.length / 6));

  let out = '';
  values.forEach((v, i) => {
    const h = (v / max) * ih;
    const bx = padL + i * bw + bw * 0.15;
    out += `<rect x="${bx.toFixed(1)}" y="${(padT + ih - h).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(h, v > 0 ? 2 : 0).toFixed(1)}" rx="3" fill="${ACCENT}"><title>${esc(fmtDay(labels[i]))}: ${v}</title></rect>`;
    if (i % step === 0) out += `<text x="${(padL + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="${MUTED}">${esc(fmtDay(labels[i]))}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="width:100%;height:auto" role="img">${out}</svg>`;
}

function hoursChart(hours: number[]): string {
  const W = 780;
  const H = 150;
  const padL = 26;
  const padR = 10;
  const padT = 10;
  const padB = 22;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const bw = iw / 24;
  const max = Math.max(1, ...hours, 1);

  const color = (v: number): string => {
    const t = v / max;
    const r = Math.round(0x6d + (0xc4 - 0x6d) * t);
    const g = Math.round(0x28 + (0xb5 - 0x28) * t);
    const b = Math.round(0xd9 + (0xfd - 0xd9) * t);
    return `rgb(${r},${g},${b})`;
  };

  let out = '';
  hours.forEach((v, i) => {
    const h = (v / max) * ih;
    const bx = padL + i * bw + bw * 0.12;
    out += `<rect x="${bx.toFixed(1)}" y="${(padT + ih - h).toFixed(1)}" width="${(bw * 0.76).toFixed(1)}" height="${Math.max(h, v > 0 ? 2 : 0).toFixed(1)}" rx="2" fill="${color(v)}"><title>${i}:00 — ${v}</title></rect>`;
    if ([0, 6, 12, 18, 23].includes(i)) out += `<text x="${(padL + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="${MUTED}">${i}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="width:100%;height:auto" role="img">${out}</svg>`;
}

function donut(items: { label: string; value: number }[]): string {
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  const r = 54;
  const c = 2 * Math.PI * r;
  let off = 0;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 140" width="170" height="170" style="width:170px;height:170px"><circle cx="70" cy="70" r="${r}" fill="none" stroke="#21212b" stroke-width="18"/>`;
  items.forEach((it, i) => {
    const len = (it.value / total) * c;
    out += `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${DONUT_COLORS[i % DONUT_COLORS.length]}" stroke-width="18" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)"><title>${esc(it.label)}: ${it.value}</title></circle>`;
    off += len;
  });
  out += `<text x="70" y="66" text-anchor="middle" font-size="20" font-weight="700" fill="#ececf2">${total}</text><text x="70" y="84" text-anchor="middle" font-size="10" fill="${MUTED}">всего</text></svg>`;
  return out;
}

function barsList(rows: { label: string; value: number }[], unit = ''): string {
  if (!rows.length) return '<div class="muted">нет данных</div>';
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows
    .map(
      (r) =>
        `<div class="brow"><div>${esc(r.label)}</div><div class="track"><div class="fill" style="width:${((r.value / max) * 100).toFixed(1)}%"></div></div><div class="num">${r.value}${esc(unit)}</div></div>`,
    )
    .join('');
}

function st(on: boolean): string {
  return on ? '<span class="st on"></span>' : '<span class="st off"></span>';
}

/** Собирает автономный HTML-отчёт по снимку статистики (дизайн = страница /dev/). */
export function renderReportHtml(stats: StatsResponse, note?: string): string {
  const now = stats.generatedAt;
  const on15 = stats.online.find((o) => o.windowMinutes === 15)?.count ?? 0;
  const win = stats.windows.d1;
  const cats = stats.categoriesPeriod.map((c, i) => ({ label: CAT_LABELS[c.name] || c.name, value: c.value, color: DONUT_COLORS[i % DONUT_COLORS.length] }));
  const catTotal = cats.reduce((a, b) => a + b.value, 0) || 1;

  const seriesLabels = stats.series.map((s) => s.label);
  const dauVals = stats.series.map((s) => s.value);
  const reqVals = stats.series.map((s) => s.requests);
  const minDau = dauVals.length ? Math.min(...dauVals) : 0;
  const maxDau = Math.max(0, ...dauVals);
  const avgDau = dauVals.length ? (dauVals.reduce((a, b) => a + b, 0) / dauVals.length).toFixed(1) : '0';

  const funnelRows = stats.funnel
    .map(
      (f) =>
        `<div class="brow"><div>${esc(f.step)}</div><div class="track"><div class="fill" style="width:${f.percent}%"></div></div><div class="num">${f.count} · ${f.percent}%</div></div>`,
    )
    .join('');

  const worst = stats.funnel
    .map((f, i) => ({ drop: i ? stats.funnel[i - 1].count - f.count : 0, step: f.step }))
    .slice(1)
    .sort((a, b) => b.drop - a.drop)[0];
  const funnelNote = worst && worst.drop > 0 ? `Основной отвал — на шаге «${esc(worst.step)}» (−${worst.drop}).` : 'Отвала между шагами нет.';

  const kindLabels: Record<string, string> = { photo: 'Фото', pdf: 'PDF', other: 'Прочее' };
  const kinds = stats.content.filesByKind
    .filter((k) => k.value > 0)
    .map((k, i) => ({ label: kindLabels[k.name] || k.name, value: k.value, color: DONUT_COLORS[i % DONUT_COLORS.length] }));

  const userRows = stats.users.rows
    .map(
      (u) =>
        `<tr><td>${esc(u.name)}</td><td class="${u.group ? '' : 'muted'}">${esc(u.group || '—')}</td>` +
        `<td>${esc(u.registeredAt ? fmtDay(u.registeredAt) : '—')}</td>` +
        `<td>${esc(rel(u.lastSeenAt, now))}</td>` +
        `<td>${st(u.barsAuthorized)}</td><td>${u.telegram ? st(true) : '<span class="muted">—</span>'}</td>` +
        `<td>${u.notifications ? st(true) : '<span class="muted">—</span>'}</td></tr>`,
    )
    .join('') || '<tr><td colspan="7" class="muted">нет</td></tr>';

  const load = stats.load;
  const uptime = `${Math.floor(load.uptimeSec / 86400)} д ${Math.floor((load.uptimeSec % 86400) / 3600)} ч`;

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<meta name="color-scheme" content="dark"/>
<title>HUB · СТАТИСТИКА · ${esc(stats.moscowNow.date)}</title>
<style>
  :root{--bg:#0f0f14;--surface:#1a1a22;--surface-2:#21212b;--border:#2a2a36;--text:#ececf2;--muted:#8b8b9c;--accent:#8b5cf6;--accent-light:#a78bfa;--accent-dark:#6d28d9;--good:#34d399;--danger:#f87171;--radius:14px;--shadow:0 1px 2px rgba(0,0,0,.3)}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:20px 16px 60px;-webkit-text-size-adjust:100%}
  .wrap{max-width:1120px;margin:0 auto}
  header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:4px}
  h1{font-size:17px;margin:0;font-weight:800;letter-spacing:.06em}
  .updated{color:var(--muted);font-size:12.5px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--accent-light);margin:30px 0 12px;font-weight:700}
  .grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:15px 16px;box-shadow:var(--shadow)}
  .card .label{color:var(--muted);font-size:12.5px;margin-bottom:7px}
  .card .value{font-size:30px;font-weight:800;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
  .card .hint{color:var(--muted);font-size:12px;margin-top:5px;min-height:15px}
  .delta.up{color:var(--good)}.delta.flat{color:var(--muted)}
  .chart{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 6px 6px;box-shadow:var(--shadow)}
  .chart svg{display:block;width:100%;height:auto}
  .cap{display:flex;gap:16px;padding:4px 14px 10px;color:var(--muted);font-size:12.5px;flex-wrap:wrap}.cap b{color:var(--text)}
  .bars-list{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow);display:grid;gap:9px}
  .brow{display:grid;grid-template-columns:150px 1fr 84px;gap:10px;align-items:center;font-size:13.5px}
  .brow .track{height:9px;background:var(--surface-2);border-radius:999px;overflow:hidden}
  .brow .fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent-light))}
  .brow .num{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
  .donut-wrap{display:grid;grid-template-columns:180px 1fr;gap:14px;align-items:center}
  .legend{display:grid;gap:8px}.legend .li{display:flex;align-items:center;gap:8px;font-size:13.5px}
  .legend .sw{width:11px;height:11px;border-radius:3px;flex:0 0 auto}.legend .pct{margin-left:auto;color:var(--muted)}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  .table-scroll{overflow-x:auto;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
  th,td{text-align:left;padding:10px 12px;white-space:nowrap;border-bottom:1px solid var(--border)}
  th{color:var(--muted);font-weight:700;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em}
  tr:last-child td{border-bottom:none}
  .st{display:inline-block;width:9px;height:9px;border-radius:50%}.st.on{background:var(--good)}.st.off{background:var(--muted);opacity:.35}
  .muted{color:var(--muted)}
  .conclusion{color:var(--muted);font-size:13px;margin-top:10px}
  .two{display:grid;gap:12px;grid-template-columns:1fr}
  @media (min-width:760px){.two{grid-template-columns:320px 1fr}}
  .foot{color:var(--muted);font-size:12px;margin-top:30px;text-align:center}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>HUB · СТАТИСТИКА</h1>
    <span class="updated">срез на ${esc(new Date(now).toLocaleString('ru-RU'))} МСК · период ${esc(stats.period)}</span>
  </header>
  ${note ? `<p class="muted">${esc(note)}</p>` : ''}

  <h2>Прямо сейчас</h2>
  <div class="grid">
    ${kpi('Пользователей онлайн (15 мин)', on15)}
    ${kpi('Запросов в минуту', stats.requestsPerMinute, 'с начала суток')}
    ${kpi('Сессий БАРС живых', stats.liveBarsSessions)}
    ${kpi('Ошибок 5xx за час', stats.errorsLastHour, stats.errorsLastHour > 0 ? 'проверить журнал' : 'всё чисто')}
  </div>

  <h2>Ключевые цифры (за сутки)</h2>
  <div class="grid">
    ${kpi('Всего пользователей', stats.kpi.users, `<span class="delta ${win.newUsers ? 'up' : 'flat'}">${win.newUsers ? '+' : '±'}${win.newUsers}</span> за сутки`)}
    ${kpi('Новых за сутки', win.newUsers)}
    ${kpi('Активных за сутки', win.activeUsers, `${win.requests} запросов`)}
    ${kpi('ДЗ создано за сутки', stats.content.homeworkPeriod, `всего ${stats.content.homeworkTotal}`)}
    ${kpi('Файлов загружено', stats.content.filesTotal, bytes(stats.content.filesBytes))}
    ${kpi('Уведомлений отправлено', stats.notifications.sent)}
  </div>

  <h2>Активные пользователи · 24 часа</h2>
  <div class="chart">${lineChart(stats.series.map((s) => ({ label: s.label, value: s.value })))}</div>
  <div class="cap"><span>min <b>${minDau}</b></span><span>avg <b>${avgDau}</b></span><span>max <b>${maxDau}</b></span></div>

  <h2>Запросы · 24 часа</h2>
  <div class="chart">${barChart(reqVals, seriesLabels)}</div>
  <div class="cap"><span>сумма <b>${reqVals.reduce((a, b) => a + b, 0)}</b></span></div>

  <h2>Активность по часам (МСК, сутки)</h2>
  <div class="chart">${hoursChart(stats.series.map((s) => s.value))}</div>

  <h2>Запросы по разделам (сутки)</h2>
  <div class="card">
    ${cats.length
      ? `<div class="donut-wrap"><div>${donut(cats)}</div><div class="legend">${cats
          .map((c) => `<div class="li"><span class="sw" style="background:${c.color}"></span>${esc(c.label)}<span class="pct">${Math.round((c.value / catTotal) * 100)}% · ${c.value}</span></div>`)
          .join('')}</div></div>`
      : '<div class="muted">нет данных</div>'}
  </div>

  <h2>Пользователи</h2>
  <div class="table-scroll">
    <table>
      <thead><tr><th>ФИО</th><th>Группа</th><th>Регистрация</th><th>Активность</th><th>БАРС</th><th>Telegram</th><th>Уведомления</th></tr></thead>
      <tbody>${userRows}</tbody>
    </table>
  </div>

  <h2>Нагрузка на ВПС</h2>
  <div class="grid">
    ${kpi('Аптайм процесса', uptime)}
    ${kpi('Память RSS / heap', `${load.rssMb} / ${load.heapMb} МБ`)}
    ${kpi('Размер data/', bytes(load.dataBytes))}
    ${kpi('Файлов на диске', load.filesOnDisk)}
    ${kpi('Запросов 4xx / 5xx', `${load.status4xx} / ${load.status5xx}`)}
    ${kpi('Время ответа p50 / p95', `${load.latencyP50} / ${load.latencyP95} мс`)}
    ${kpi('Снимков БАРС на диске', load.snapshots)}
  </div>

  <h2>Воронка</h2>
  <div class="bars-list">${funnelRows}</div>
  <div class="conclusion">${funnelNote}</div>

  <h2>БАРС</h2>
  <div class="grid">
    ${kpi('Успешных входов (30 дней)', stats.bars.logins)}
    ${kpi('Истёкших сессий', stats.bars.expired)}
    ${kpi('С живой сессией', stats.bars.live)}
    ${kpi('Без сессии', stats.bars.stale)}
  </div>
  ${stats.bars.errorsBySection.length ? `<div class="bars-list" style="margin-top:12px"><div class="muted" style="margin-bottom:4px">Ошибки БАРС по разделам (7 дней)</div>${barsList(stats.bars.errorsBySection.map((e) => ({ label: e.name, value: e.value })))}</div>` : ''}

  <h2>Контент</h2>
  <div class="grid">
    ${kpi('ДЗ всего / за сутки', `${stats.content.homeworkTotal} / ${stats.content.homeworkPeriod}`)}
    ${kpi('«Важное» всего / за сутки', `${stats.content.importantTotal} / ${stats.content.importantPeriod}`)}
    ${kpi('Файлов / объём', `${stats.content.filesTotal} / ${bytes(stats.content.filesBytes)}`, `средний ${bytes(stats.content.filesAvgBytes)}`)}
  </div>
  <div class="two" style="margin-top:12px">
    <div class="card">
      <div class="label">Медиа: фото / PDF / прочее</div>
      ${kinds.length
        ? `<div class="donut-wrap"><div>${donut(kinds)}</div><div class="legend">${kinds
            .map((k) => `<div class="li"><span class="sw" style="background:${k.color}"></span>${esc(k.label)}<span class="pct">${k.value}</span></div>`)
            .join('')}</div></div>`
        : '<div class="muted">файлов нет</div>'}
    </div>
    <div class="bars-list">
      <div class="muted" style="margin-bottom:4px">ДЗ по группам (сутки, топ-5)</div>
      ${barsList(stats.content.homeworkByGroup.map((g) => ({ label: g.group, value: g.value })))}
    </div>
  </div>
  <div class="bars-list" style="margin-top:12px">
    <div class="muted" style="margin-bottom:4px">Топ-5 файлов по размеру</div>
    ${stats.content.filesTop.length ? barsList(stats.content.filesTop.map((f) => ({ label: f.name, value: Math.round(f.bytes / 1024) })), ' КБ') : '<div class="muted">нет файлов</div>'}
  </div>

  <div class="foot">Hub · личный срез статистики · ${esc(stats.moscowNow.date)} ${esc(stats.moscowNow.time)} МСК</div>
</div>
</body>
</html>`;
}
