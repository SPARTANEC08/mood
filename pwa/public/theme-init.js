/*
 * Инициализация темы и палитры до первого кадра.
 *
 * Работает до бандла React и до применения styles.css, поэтому тема стоит уже
 * на самом первом кадре — вспышки нет. Логика намеренно повторяет только
 * выбор варианта из lib/theme.ts; сами цвета не считаются заново: приложение
 * заранее кладёт готовые токены в localStorage (`mood_theme_tokens`).
 *
 * Это отдельный файл, а не инлайн-скрипт, из-за CSP продакшена: политика
 * разрешает `script-src 'self'`, то есть инлайновый скрипт в index.html был бы
 * заблокирован. Внешний файл из public/ — same-origin и проходит.
 */

(function () {
  var THEME_KEY = 'mood_theme';
  var SELECTED_KEY = 'mood_theme_selected';
  var TOKENS_KEY = 'mood_theme_tokens';
  var ACCENT_KEY = 'mood_accent';
  var TOKEN_KEY = 'mood_pwa_token';
  var GUEST_KEY = 'mood_guest_mode';
  var DEFAULT_ACCENT = '#7c4dff';

  var TOKEN_VARS = {
    appBg: '--app-bg',
    surface: '--surface',
    surfaceGrouped: '--surface-grouped',
    surfaceBlur: '--surface-blur',
    textPrimary: '--text-primary',
    textSecondary: '--text-secondary',
    textTertiary: '--text-tertiary',
    separator: '--separator',
    separatorSoft: '--separator-soft',
    accent: '--accent',
    accentSoft: '--accent-soft',
    accentText: '--accent-text',
    accentFade1: '--accent-fade-1',
    accentFade2: '--accent-fade-2',
    accentFade3: '--accent-fade-3',
    shadowCard: '--shadow-card',
  };

  var mode = 'dark';
  var selected = null;
  var tokens = null;
  var token = null;
  var guest = null;
  var legacyAccent = null;

  try {
    var storedTheme = localStorage.getItem(THEME_KEY);
    if (storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system') {
      mode = storedTheme;
    }

    token = localStorage.getItem(TOKEN_KEY);
    guest = localStorage.getItem(GUEST_KEY);
    legacyAccent = localStorage.getItem(ACCENT_KEY);

    var rawSelected = localStorage.getItem(SELECTED_KEY);
    if (rawSelected) selected = JSON.parse(rawSelected);

    var rawTokens = localStorage.getItem(TOKENS_KEY);
    if (rawTokens) tokens = JSON.parse(rawTokens);
  } catch (e) {
    /* Приватный режим/битые данные — остаёмся на значениях из index.css. */
  }

  var root = document.documentElement;
  var dark = mode === 'dark';

  if (mode === 'system') {
    try {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {
      dark = true;
    }
  }

  root.setAttribute('data-theme-mode', mode);
  root.style.colorScheme = dark ? 'dark' : 'light';

  function setMeta(hex) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', hex);
  }

  function removeTokenVars() {
    for (var field in TOKEN_VARS) {
      if (Object.prototype.hasOwnProperty.call(TOKEN_VARS, field)) {
        root.style.removeProperty(TOKEN_VARS[field]);
      }
    }
  }

  function applyTokens(value) {
    if (!value || typeof value !== 'object') return false;

    var applied = false;
    for (var field in TOKEN_VARS) {
      if (!Object.prototype.hasOwnProperty.call(TOKEN_VARS, field)) continue;
      var color = value[field];
      if (typeof color !== 'string' || color.length === 0) continue;
      root.style.setProperty(TOKEN_VARS[field], color);
      applied = true;
    }

    if (applied && typeof value.themeColor === 'string') {
      setMeta(value.themeColor);
    }

    return applied;
  }

  /* Гость и экран входа остаются на фирменной палитре. */
  if (!token || guest === '1') {
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.removeAttribute('data-theme-id');
    removeTokenVars();
    setMeta(dark ? '#15131e' : '#f4f2fb');
    return;
  }

  var hasLight = selected && selected.variants && selected.variants.light;
  var hasDark = selected && selected.variants && selected.variants.dark;
  var variant = dark ? 'dark' : 'light';

  /* Один вариант — принудительно он, даже если системная тема другая. */
  if (hasLight && !hasDark) variant = 'light';
  else if (hasDark && !hasLight) variant = 'dark';

  root.setAttribute('data-theme', variant);
  root.style.colorScheme = variant;

  if (selected && typeof selected.id === 'string') {
    root.setAttribute('data-theme-id', selected.id);
  }

  var applied = tokens && tokens[variant] ? applyTokens(tokens[variant]) : false;

  /*
   * Fallback на один релиз: у пользователя ещё нет новых токенов, но есть
   * старый персональный акцент. Повторяем прежнюю формулу, чтобы обновление
   * не дало вспышку фиолетового.
   */
  if (!applied && legacyAccent) {
    applyLegacyAccent(legacyAccent);
  }

  function applyLegacyAccent(input) {
    function parseHex(value) {
      if (typeof value !== 'string') return null;
      value = value.trim().toLowerCase();
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

    function contrastRatio(a, b) {
      var left = parseHex(a);
      var right = parseHex(b);
      if (!left || !right) return 1;
      var la = 0.2126 * channelLuminance(left.r) + 0.7152 * channelLuminance(left.g) + 0.0722 * channelLuminance(left.b);
      var lb = 0.2126 * channelLuminance(right.r) + 0.7152 * channelLuminance(right.g) + 0.0722 * channelLuminance(right.b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    }

    var base = parseHex(input);
    if (!base) return;
    var normalized = rgbToHex(base);
    if (normalized === DEFAULT_ACCENT) return;

    var hsl = rgbToHsl(base);
    var lightness = hsl.l;
    if (variant === 'light' && lightness > 0.78) lightness = 0.55;
    if (variant === 'dark' && lightness < 0.5) lightness = 0.65;

    var accent = hslToHex(hsl.h, hsl.s, lightness);
    var accentRgb = parseHex(accent);
    var text = contrastRatio(accent, '#ffffff') >= 4.5 ? '#ffffff' : '#15131e';

    root.style.setProperty('--accent', accent);
    root.style.setProperty(
      '--accent-soft',
      'rgba(' + accentRgb.r + ', ' + accentRgb.g + ', ' + accentRgb.b + ', ' + (variant === 'dark' ? 0.2 : 0.12) + ')'
    );
    root.style.setProperty('--accent-text', text);
    root.style.setProperty('--accent-fade-1', hslToHex(hsl.h, hsl.s, Math.min(1, lightness + 0.12)));
    root.style.setProperty('--accent-fade-2', hslToHex(hsl.h, hsl.s, Math.max(0, lightness - 0.08)));
    root.style.setProperty('--accent-fade-3', hslToHex(hsl.h, hsl.s, Math.max(0, lightness - 0.18)));
  }
})();
