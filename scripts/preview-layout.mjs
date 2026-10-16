/**
 * Ссылка для проверки вёрстки на телефоне.
 *
 * Поднимает собранный фронтенд с подставными данными (scripts/mock-api.mjs) и
 * пробрасывает наружу через cloudflared: телефон открывает обычный https-адрес,
 * Telegram при этом не нужен.
 *
 * Запуск: node scripts/preview-layout.mjs [порт]
 * Остановить: Ctrl+C
 */

import { spawn } from 'node:child_process';

import { startMockServer } from './mock-api.mjs';

const PORT = Number(process.argv[2] ?? 5199);
const { server } = await startMockServer(PORT);

console.log(`Сборка отдаётся на http://127.0.0.1:${PORT}`);

if (process.platform === 'darwin') {
  // На macOS туннель без зоны не поднимется: нужен либо --config, либо
  // подтверждённый адрес. Quick Tunnel работает без зоны, поэтому просто
  // предупреждаем и запускаем как есть.
  console.log('Поднимаю туннель cloudflared (Quick Tunnel, адрес будет ниже)…');
}

const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

tunnel.stdout.on('data', (chunk) => {
  const text = String(chunk);
  const match = /https:\/\/[^\s]+\.trycloudflare\.com/.exec(text);
  if (match) {
    console.log(`\nОткрывай на iPhone: ${match[0]}\n`);
  } else {
    process.stdout.write(text);
  }
});

tunnel.stderr.on('data', (chunk) => process.stderr.write(chunk));

const stop = () => {
  tunnel.kill();
  server.close();
  process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
tunnel.on('exit', (code) => {
  server.close();
  process.exit(code ?? 0);
});