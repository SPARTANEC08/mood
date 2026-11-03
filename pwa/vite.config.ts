import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Конфигурация веб-версии (PWA).
 *
 * Приложение одно, и всё лежит в этом же каталоге src: страницы, компоненты,
 * дизайн-система и клиент API. Раньше интерфейс жил в webapp/src и собирался
 * отсюда через подмену двух модулей на шимы — теперь подменять нечего, поэтому
 * и плагина webappShims, и алиаса @pwa больше нет.
 *
 * Остаётся единственный алиас @ на ./src: импорты вида '@/pages/SchedulePage'
 * переехали из webapp вместе с файлами и не должны разъезжаться с расположением
 * папок при следующем переименовании.
 */

// Каталог конфига берём из import.meta.url, а не из __dirname: Vite 8 переводит
// конфиг на configLoader: 'native', где __dirname не существует, и сборка упала
// бы на следующем мажоре с невнятным ReferenceError.
const ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),

  ],

  resolve: {
    /**
     * React должен быть ОДИН во всём бандле.
     *
     * Каждая сборка приложения — это отдельный npm-проект со своим
     * node_modules, и без dedupe оптимизатор зависимостей Vite в некоторых
     * версиях вклеивает в framer-motion его собственную копию внутренностей
     * React (ReactCurrentDispatcher с current: null). Рендерит при этом
     * react-dom: он ставит диспетчер в свой экземпляр, framer-motion читает
     * из своего — и падает «Cannot read properties of null (reading 'useRef')»
     * на первом же компоненте с анимацией, то есть на чёрный экран.
     *
     * Ошибка выглядит как «mismatching versions of React and the renderer»,
     * хотя версии у них одинаковые, и поэтому сбивает с толку.
     */
    dedupe: ['react', 'react-dom'],

    // Важен и порядок, и форма записи: строковый ключ в Vite заменяется по
    // префиксу, и «@» без обязательного слэша после совпал бы с именами
    // npm-пакетов вида «@scope/name». Поэтому правило задано регуляркой с
    // обязательным слэшем.
    alias: [{ find: /^@\//, replacement: path.resolve(ROOT, './src') + '/' }],
  },

  optimizeDeps: {
    /**
     * React и react-dom обязаны быть общими для всех оптимизируемых пакетов.
     *
     * Без этого флага framer-motion оптимизируется вместе со своей копией
     * внутренностей React (см. dedupe выше), и первая анимация роняет дерево.
     */
    include: ['react', 'react-dom', 'react/jsx-runtime', 'framer-motion', 'lucide-react'],
  },

  server: {
    // Порт 5173 оставлен прежним, чтобы старые закладки и туннели продолжали
    // попадать в dev-сервер.
    port: 5173,
    host: true,
    /**
     * Приложение открывают и через туннель (trycloudflare/ngrok) при локальной
     * отладке, а Vite на чужом Host отвечает 403 из-за защиты от
     * DNS-rebinding.
     */
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '.trycloudflare.com',
      '.ngrok-free.app',
      '.ngrok.app',
    ],
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
    // Манифест сборки: список реально выпущенных файлов с их хешами в именах.
    // Service Worker читает его при install и кладёт в кэш оболочки — без этого
    // офлайн открывал бы index.html, в котором не загрузились бы ни один бандл
    // и ни один стиль. Список бандлов заранее неизвестен: их имена меняются
    // при каждой сборке, и захардкодить их можно только вручную.
    manifest: '.vite/manifest.json',
    rollupOptions: {
      input: {
        // Основное приложение.
        main: path.resolve(ROOT, 'index.html'),
        // Скрытая тестовая страница: те же компоненты на моковых данных.
        // Нигде не слинкована, закрыта от индексации.
        test: path.resolve(ROOT, 'test/index.html'),
        // Демо-стенд для скриншотов: та же страница, но по адресу /preview/.
        // /test/ на проде закрыт nginx, а показать новые экраны нужно без
        // временного ослабления правил безопасности.
        preview: path.resolve(ROOT, 'preview/index.html'),
        // Отдельное демо PDF-просмотрщика: /preview/pdf.html.
        pdfDemo: path.resolve(ROOT, 'preview/pdf.html'),
      },
      output: {
        // Зависимости меняются редко, и вынос их отдельно не сбрасывает кэш
        // оболочки при каждой правке интерфейса.
        manualChunks(id) {
          // PDF.js и react-pdf намеренно НЕ выделяем в общий чанк: manualChunks
          // делает его статическим импортом точки входа, и полмегабайта PDF.js
          // попадали в предзагрузку первого кадра. Без правила они уезжают в
          // ленивый чанк вьюера и грузятся только при открытии PDF.
          if (id.includes('node_modules/pdfjs-dist') || id.includes('node_modules/react-pdf')) {
            return undefined;
          }
          if (id.includes('node_modules/react')) return 'react';
          if (id.includes('node_modules/lucide-react')) return 'icons';
          return undefined;
        },
      },
    },
  },

  define: {
    // Метка сборки. Подставляется и в бандл, и (через отдельный скрипт) в sw.js,
    // чтобы Service Worker знал, какая версия сейчас на сервере.
    __SW_VERSION__: JSON.stringify(
      `${process.env.SOURCE_DATE_EPOCH ?? Date.now().toString(36)}`,
    ),
  },
});