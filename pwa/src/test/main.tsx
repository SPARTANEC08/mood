/**
 * Точка входа тестовой страницы /test/.
 *
 * Первый импорт — setup: он подменяет fetch и localStorage до того, как
 * приложение начнёт читать кэш и токен. Дальше монтируется обычный ScheduleApp,
 * поэтому страница выглядит и ведёт себя как настоящее приложение, но на
 * моковых данных.
 */

import './setup';

import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { ScheduleApp } from '@/app/ScheduleApp';
import { PdfViewerScreen } from '@/components/PdfViewerScreen';
import type { ServerFileRef } from '@/types/api';
import { initDocument } from '@/lib/env';
import { initTheme } from '@/lib/theme';
import { bindViewportHeight } from '@/lib/viewport';
import '../styles.css';

initDocument();
initTheme();
bindViewportHeight();

const container = document.getElementById('root');
if (!container) throw new Error('Не найден элемент #root');

/**
 * Тестовый PDF из базы: 91 страница, 1.5 МБ.
 *
 * Открывается кнопкой или сразу по `?pdf=1`. Файл лежит в
 * `pwa/public/test/sample.pdf`, поэтому авторизация и API не участвуют.
 */
const TEST_PDF: ServerFileRef = {
  fileId: 'test-pdf',
  originalName: 'Сборник задач по физике.pdf',
  mimeType: 'application/pdf',
  size: 1_536_487,
  uploadedBy: 'test',
  uploadedAt: new Date().toISOString(),
  sha256: 'test',
};

function PdfTestLauncher() {
  const [open, setOpen] = useState(
    () => new URLSearchParams(window.location.search).get('pdf') === '1',
  );

  return (
    <>
      {open ? (
        <PdfViewerScreen file={TEST_PDF} srcUrl="/test/sample.pdf" onClose={() => setOpen(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="pressable fixed right-3 z-[60] rounded-full px-4 py-2.5 text-[13px] font-semibold text-white shadow-lg active:pressable-active"
          style={{
            bottom: 'calc(var(--tabbar-height, 64px) + 12px)',
            background: 'var(--accent)',
          }}
        >
          Тест PDF
        </button>
      )}
    </>
  );
}

createRoot(container).render(
  <StrictMode>
    <ScheduleApp onReLogin={() => undefined} />
    <PdfTestLauncher />
  </StrictMode>,
);
