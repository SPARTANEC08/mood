/**
 * Декларации для файлов, которые Vite обрабатывает как ассеты.
 *
 * TypeScript не понимает импорт CSS, шрифтов и картинок — без этого файла
 * проверка типов падает на `import './index.css'`.
 */

declare module '*.css';
declare module '*.scss';
declare module '*.sass';
declare module '*.less';

declare module '*.svg' {
  const src: string;
  export default src;
}

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}

declare module '*.woff2' {
  const src: string;
  export default src;
}

declare module '*.woff' {
  const src: string;
  export default src;
}