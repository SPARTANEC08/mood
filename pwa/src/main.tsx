import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { rememberInstallPrompt } from './components/InstallPrompt';
import { initDocument } from '@/lib/env';
import { initTheme } from '@/lib/theme';
import { bindViewportHeight } from '@/lib/viewport';
import { registerServiceWorker } from './sw-register';
import './styles.css';

/**
 * Точка входа веб-версии.
 *
 * Отличие от прежнего webapp/src/main.tsx — регистрация Service Worker и свои
 * стили. Сам компонент приложения переехал в app/ScheduleApp.tsx, а подготовку
 * документа и темы теперь делает lib/env.ts: Telegram SDK больше нет.
 */

// Подготовка документа: жесты, масштаб и системная тема.
initDocument();

// Тема из выбора пользователя (тёмная по умолчанию). Идёт после
// initDocument(), чтобы перекрыть color-scheme, выставленный там по системе.
// Ранний theme-init.js уже выставил data-theme до первого кадра — здесь только
// согласование с рантаймом.
initTheme();

// Событие установки ловится ДО рендера: браузер присылает его раньше, чем
// отрисуется первый экран, и поймать его позже уже нельзя. На iOS события нет
// вовсе — там кнопка «Установить» открывает панель «Поделиться».
window.addEventListener('beforeinstallprompt', rememberInstallPrompt);

// Высота --app-height для #root. До рендера и до регистрации воркера: первый
// кадр должен уже быть посчитан по visual viewport, иначе на iPhone корзина
// на мгновение рисуется по большому вьюпорту и TabBar дёргается вниз.
bindViewportHeight();

registerServiceWorker();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Не найден элемент #root');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);