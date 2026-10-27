/**
 * HTML-отчёт и срез страницы /dev.
 *
 * Ровно те девять пунктов, что нужны владельцу: состояние сейчас, окно 24 часа,
 * диаграмма запросов по часам, ДЗ и «Важное», файлы пользователей и список
 * сессий БАРС. Ничего лишнего: чем короче документ, тем меньше он весит — а
 * отчёт сохраняется файлом для истории и открывается в админке.
 *
 * Источник данных — `getStats()` из devStats.ts (тот же ответ отдаётся странице).
 */

import type { StatsResponse, StatsSessionRow } from '../../server/devStats.ts';

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** «19.10, 14:32» по Москве. */
function stamp(ms: number): string {
  if (!ms) return '—';
  const date = new Date(ms + 3 * 60 * 60 * 1000);
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  return `${dd}.${mm}, ${hh}:${mi}`;
}

/** «1,2 МБ» / «340 КБ». */
function size(bytes: number): string {
  if (!bytes) return '0';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function barsLabel(row: StatsSessionRow): string {
  return row.bars === 'active' ? 'активна' : row.bars === 'expired' ? 'истекла' : 'нет';
}

/** Эмодзи платформы для списка пользователей. */
function platformEmoji(platform: StatsSessionRow['platform']): string {
  return platform === 'ios' ? '🍏' : platform === 'android' ? '🤖' : platform === 'web' ? '🌐' : '❓';
}

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0f0f14;color:#ececf2;font:14px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:19px;margin:0 0 2px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#8b8b9c;margin:26px 0 10px}
.muted{color:#8b8b9c;font-size:12.5px;margin:0 0 4px}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.card{background:#1a1a22;border:1px solid #2a2a36;border-radius:12px;padding:12px 14px}
.k{font-size:12px;color:#8b8b9c}
.v{font-size:24px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums}
.hint{font-size:11.5px;color:#8b8b9c;margin-top:3px}
.chart{display:flex;align-items:flex-end;gap:3px;height:90px;background:#1a1a22;border:1px solid #2a2a36;border-radius:12px;padding:10px}
.chart i{flex:1;background:#8b5cf6;border-radius:3px 3px 0 0;min-height:2px}
.labels{display:flex;gap:3px;margin-top:4px;font-size:10px;color:#8b8b9c}
.labels span{flex:1;text-align:center}
table{width:100%;border-collapse:collapse;background:#1a1a22;border:1px solid #2a2a36;border-radius:12px;overflow:hidden}
th,td{padding:8px 10px;text-align:left;border-top:1px solid #2a2a36;font-size:13px;vertical-align:top}
th{color:#8b8b9c;font-weight:500;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;border-top:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.ok{color:#34d399}.warn{color:#fbbf24}.off{color:#8b8b9c}
.foot{margin-top:26px;color:#8b8b9c;font-size:12px}
`.trim();

/**
 * Отчёт для истории статистики.
 *
 * `note` — короткая подпись под шапкой (например, «Отчёт по кнопке»).
 */
export function renderReportHtml(stats: StatsResponse, note?: string): string {
  const w = stats.window;
  const hours = stats.requestsByHour;
  const maxHour = Math.max(1, ...hours.map((h) => h.value));

  const files = stats.files;
  const fileRows = files.byUser
    .map(
      (row) => `<tr>
        <td>${esc(row.name)}<div class="hint">${esc(row.group || '—')}</div></td>
        <td class="num">${row.files}</td>
        <td class="num">${size(row.bytes)}</td>
        <td class="num">${stamp(row.lastUploadAt)}</td>
      </tr>`,
    )
    .join('');

  const sessionRows = stats.sessions
    .map(
      (row) => `<tr>
        <td>${platformEmoji(row.platform)} ${esc(row.name)}<div class="hint">${esc(row.group || '—')}</div></td>
        <td class="num">${stamp(row.lastSeenAt)}</td>
        <td class="${row.bars === 'active' ? 'ok' : row.bars === 'expired' ? 'warn' : 'off'}">${barsLabel(row)}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="ru"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<meta name="color-scheme" content="dark"/>
<title>MOOD · СТАТИСТИКА · ${esc(stats.moscowNow.date)}</title>
<style>${CSS}</style>
</head><body><div class="wrap">
  <h1>MOOD · СТАТИСТИКА</h1>
  <p class="muted">24 часа: ${esc(stamp(stats.windowStart))} — ${esc(stamp(stats.windowEnd))} · снято ${esc(stats.moscowNow.time)} МСК</p>
  ${note ? `<p class="muted">${esc(note)}</p>` : ''}

  <h2>Сейчас</h2>
  <div class="grid">
    <div class="card"><div class="k">Активных сессий БАРС</div><div class="v">${stats.current.barsSessions}</div></div>
    <div class="card"><div class="k">Онлайн (±5 мин)</div><div class="v">${stats.current.online}</div></div>
  </div>

  <h2>За 24 часа</h2>
  <div class="grid">
    <div class="card"><div class="k">Запросов</div><div class="v">${w.requests}</div></div>
    <div class="card"><div class="k">Заходов в приложение</div><div class="v">${w.visits}</div></div>
    <div class="card"><div class="k">Максимум онлайна</div><div class="v">${w.maxOnline}</div><div class="hint">окно 5 минут</div></div>
    <div class="card"><div class="k">Новых сессий БАРС</div><div class="v">${w.newBarsSessions}</div><div class="hint">уникальных людей</div></div>
  </div>

  <h2>Платформы</h2>
  <div class="grid">
    <div class="card"><div class="k">🍏 iOS</div><div class="v">${stats.platforms.ios}</div></div>
    <div class="card"><div class="k">🤖 Android</div><div class="v">${stats.platforms.android}</div></div>
    <div class="card"><div class="k">🌐 Web</div><div class="v">${stats.platforms.web}</div></div>
    <div class="card"><div class="k">❓ Неизвестно</div><div class="v">${stats.platforms.unknown}</div></div>
  </div>
  <p class="muted">Платформы: iOS — ${stats.platforms.ios}, Android — ${stats.platforms.android}, Web — ${stats.platforms.web}, Unknown — ${stats.platforms.unknown}</p>

  <h2>Запросы по часам</h2>
  <div class="chart">${hours.map((h) => `<i style="height:${Math.round((h.value / maxHour) * 100)}%" title="${esc(h.label)} — ${h.value}"></i>`).join('')}</div>
  <div class="labels">${hours.map((h) => `<span>${esc(h.label.slice(0, 2))}</span>`).join('')}</div>

  <h2>ДЗ и «Важное»</h2>
  <div class="grid">
    <div class="card"><div class="k">ДЗ создано / удалено</div><div class="v">${w.homework.created} / ${w.homework.deleted}</div><div class="hint">всего сейчас: ${w.homework.total}</div></div>
    <div class="card"><div class="k">Важное создано / удалено</div><div class="v">${w.important.created} / ${w.important.deleted}</div><div class="hint">всего сейчас: ${w.important.total}</div></div>
  </div>

  <h2>Файлы · ${files.totalFiles} шт, ${size(files.totalBytes)}</h2>
  <table>
    <tr><th>Пользователь</th><th class="num">Файлов</th><th class="num">Размер</th><th class="num">Последняя загрузка</th></tr>
    ${fileRows || '<tr><td colspan="4" class="off">Файлов нет</td></tr>'}
  </table>

  <h2>Сессии БАРС · ${stats.sessions.length}</h2>
  <table>
    <tr><th>Пользователь</th><th class="num">Последний заход</th><th>БАРС</th></tr>
    ${sessionRows || '<tr><td colspan="3" class="off">Пользователей нет</td></tr>'}
  </table>

  <p class="foot">Mood · личный срез статистики · снято ${esc(stats.moscowNow.date)} ${esc(stats.moscowNow.time)} МСК</p>
</div></body></html>`;
}
