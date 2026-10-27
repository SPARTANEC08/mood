/**
 * Публичный вход в фоновый нотификатор.
 *
 * Файл оставлен тонкой точкой входа: импорты в telegramService и скриптах
 * (`startNotifier`, `checkUserNow`, `diffSnapshots`,
 * `isWithinActiveWindow` и т. д.) не меняются, а логика разложена по подмодулям:
 *
 *   - notifier/collect.ts — сетевой заход (БАРС + почта) с изоляцией ошибок;
 *   - notifier/diff.ts    — диффы снимков и рендер текста уведомления;
 *   - notifier/run.ts     — цикл опроса, доставка, обработка истечения сессии.
 */

export * from './notifier/diff.ts';
export * from './notifier/collect.ts';
export * from './notifier/run.ts';
