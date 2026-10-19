/*
 * Инициализация темы до первого кадра.
 *
 * Работает до бандла React и до применения styles.css, поэтому тема стоит уже
 * на самом первом кадре — вспышки светлой (или тёмной) темы нет. Логика
 * намеренно дублирует lib/theme.ts: там она для рантайма, здесь — для
 * предрендерного старта.
 *
 * Это отдельный файл, а не инлайн-скрипт, из-за CSP продакшена: политика
 * разрешает `script-src 'self'`, то есть инлайновый скрипт в index.html был бы
 * заблокирован. Внешний файл из public/ — same-origin и проходит.
 *
 * Значения держать синхронными со lib/theme.ts: ключ mood_theme, тема по
 * умолчанию — тёмная, цвет meta theme-color — фон соответствующей темы.
 */
(function () {
  var KEY = 'mood_theme';
  var mode = 'dark';

  try {
    var stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') mode = stored;
  } catch (e) {
    /* Приватный режим/запрет storage — остаёмся на теме по умолчанию. */
  }

  var dark = mode === 'dark';
  if (mode === 'system') {
    try {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {
      dark = true;
    }
  }

  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-theme-mode', mode);
  root.style.colorScheme = dark ? 'dark' : 'light';

  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#15131e' : '#f4f2fb');
})();
