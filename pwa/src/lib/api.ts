/**
 * Публичный вход в API-клиент.
 *
 * Файл оставлен тонкой точкой входа: импорты `{ api, ApiError }` не меняются, а
 * код разложен по подмодулям:
 *
 *   - api/http.ts  — транспорт, ApiError, таймауты, токен;
 *   - api/files.ts — превью, скачивание, загрузка, удаление файлов;
 *   - api/index.ts — JSON-эндпоинты и сборка объекта `api`.
 */

export { ApiError } from './api/http.ts';
export { api } from './api/index.ts';
export type { Api } from './api/index.ts';

// Доставка готового blob системе (share-sheet / фолбэк-якорь) — одна реализация
// на тап в списке файлов и на кнопку «Поделиться» во вьюере.
export { deliverFileToSystem } from './api/files.ts';
