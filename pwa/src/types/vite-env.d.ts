/// <reference types="vite/client" />

/**
 * Типы переменных окружения Vite.
 *
 * Здесь важно свойство DEV: по нему api.ts решает, отправлять ли заголовок
 * с подписью initData. В разработке его нет и отправлять нечего, в
 * production — обязательно.
 */
interface ImportMetaEnv {
  /** true при запуске dev-сервера, false в production-сборке. */
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;

  /** Адрес API для dev-прокси (только в vite.config.ts). */
  readonly VITE_API_TARGET?: string;

  [key: string]: string | boolean | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}