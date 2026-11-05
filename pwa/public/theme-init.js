/*
 * Инициализация темы и акцента до первого кадра.
 *
 * Работает до бандла React и до применения styles.css, поэтому тема и цвет
 * стоят уже на самом первом кадре — вспышки нет. Логика намеренно дублирует
 * lib/theme.ts и lib/accent.ts: там она для рантайма, здесь — для
 * предрендерного старта.
 *
 * Это отдельный файл, а не инлайн-скрипт, из-за CSP продакшена: политика
 * разрешает `script-src 'self'`, то есть инлайновый скрипт в index.html был бы
 * заблокирован. Внешний файл из public/ — same-origin и проходит.
 *
 * Значения держать синхронными с lib/theme.ts (ключ mood_theme, тёмная тема по
 * умолчанию, цвет meta theme-color) и lib/accent.ts (ключ mood_accent, дефолт
 * #7c4dff, порог контраста 4.5, формулы производных токенов).
 */
(function () {
  var THEME_KEY = 'mood_theme';
  var ACCENT_KEY = 'mood_accent';
  var TOKEN_KEY = 'mood_pwa_token';
  var GUEST_KEY = 'mood_guest_mode';
  var DEFAULT_ACCENT = '#7c4dff';

  var mode = 'dark';
  var storedAccent = null;
  var token = null;
  var guest = null;

  try {
    var storedTheme = localStorage.getItem(THEME_KEY);
    if (storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system') {
      mode = storedTheme;
    }
    storedAccent = localStorage.getItem(ACCENT_KEY);
    token = localStorage.getItem(TOKEN_KEY);
    guest = localStorage.getItem(GUEST_KEY);
  } catch (e) {
    /* Приватный режим/запрет storage — остаёмся на значениях по умолчанию. */
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

  /* ── акцент ─────────────────────────────────────────────────────────────
   * Только для авторизованного приложения: на экране входа, в 2FA, установке
   * и у гостя цвет остаётся встроенным фиолетовым (см. lib/accent.ts).
   */
  function parseHex(input) {
    if (typeof input !== 'string') return null;
    var value = input.trim().toLowerCase();
    if (value.charAt(0) === '#') value = value.slice(1);
    if (/^[0-9a-f]{3}$/.test(value)) {
      value = value.charAt(0) + value.charAt(0) + value.charAt(1) + value.charAt(1) + value.charAt(2) + value.charAt(2);
    }
    if (!/^[0-9a-f]{6}$/.test(value)) return null;
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
    };
  }

  function rgbToHex(rgb) {
    function part(v) {
      return Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
    }
    return '#' + part(rgb.r) + part(rgb.g) + part(rgb.b);
  }

  function rgbToHsl(rgb) {
    var r = rgb.r / 255;
    var g = rgb.g / 255;
    var b = rgb.b / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var d = max - min;
    if (d === 0) return { h: 0, s: 0, l: l };
    var s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    var h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s: s, l: l };
  }

  function hslToHex(h, s, l) {
    var hue = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    var m = l - c / 2;
    var rgb;
    if (hue < 60) rgb = [c, x, 0];
    else if (hue < 120) rgb = [x, c, 0];
    else if (hue < 180) rgb = [0, c, x];
    else if (hue < 240) rgb = [0, x, c];
    else if (hue < 300) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    return rgbToHex({ r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255 });
  }

  function channelLuminance(v) {
    var c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function luminance(rgb) {
    return 0.2126 * channelLuminance(rgb.r) + 0.7152 * channelLuminance(rgb.g) + 0.0722 * channelLuminance(rgb.b);
  }

  function contrastRatio(a, b) {
    var left = parseHex(a);
    var right = parseHex(b);
    if (!left || !right) return 1;
    var la = luminance(left);
    var lb = luminance(right);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function clamp01(v) {
    return Math.min(1, Math.max(0, v));
  }

  var base = storedAccent ? parseHex(storedAccent) : null;
  if (token && guest !== '1' && base) {
    var normalized = rgbToHex(base);
    if (normalized !== DEFAULT_ACCENT) {
      var hsl = rgbToHsl(base);
      var lightness = hsl.l;
      if (!dark && lightness > 0.78) lightness = 0.55;
      if (dark && lightness < 0.5) lightness = 0.65;

      var accent = hslToHex(hsl.h, hsl.s, lightness);
      var accentRgb = parseHex(accent);
      var text = contrastRatio(accent, '#ffffff') >= 4.5 ? '#ffffff' : '#15131e';

      root.style.setProperty('--accent', accent);
      root.style.setProperty(
        '--accent-soft',
        'rgba(' + accentRgb.r + ', ' + accentRgb.g + ', ' + accentRgb.b + ', ' + (dark ? 0.2 : 0.12) + ')'
      );
      root.style.setProperty('--accent-text', text);
      root.style.setProperty('--accent-fade-1', hslToHex(hsl.h, hsl.s, clamp01(lightness + 0.12)));
      root.style.setProperty('--accent-fade-2', hslToHex(hsl.h, hsl.s, clamp01(lightness - 0.08)));
      root.style.setProperty('--accent-fade-3', hslToHex(hsl.h, hsl.s, clamp01(lightness - 0.18)));
    }
  }
})();
