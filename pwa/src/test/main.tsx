/**
 * Точка входа тестовой страницы /test/.
 *
 * Первый импорт — setup: он подменяет fetch и localStorage до того, как
 * приложение начнёт читать кэш и токен. Дальше монтируется обычный ScheduleApp,
 * поэтому страница выглядит и ведёт себя как настоящее приложение, но на
 * моковых данных.
 */

import './setup';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ScheduleApp } from '@/app/ScheduleApp';
import { initDocument } from '@/lib/env';
import { initTheme } from '@/lib/theme';
import { bindViewportHeight } from '@/lib/viewport';
import '../styles.css';

initDocument();
initTheme();
bindViewportHeight();

const container = document.getElementById('root');
if (!container) throw new Error('Не найден элемент #root');

createRoot(container).render(
  <StrictMode>
    <ScheduleApp onReLogin={() => undefined} />
  </StrictMode>,
);
