import { useCallback, useState } from 'react';
import { File as FileIcon, FileImage, FileText, Paperclip, Trash2, Upload } from 'lucide-react';

import { FileThumbnail } from '@/components/FilePreview';
import { PdfViewerScreen } from '@/components/PdfViewerScreen';
import { BottomSheet } from '@/components/ui';
import { InAppBrowser } from '@/components/InAppBrowser';
import { api } from '@/lib/api';
import { openPdf, pdfOpenErrorText } from '@/lib/openPdf';
import { haptic } from '@/lib/env';
import { cn } from '@/lib/cn';
import type { ServerFileRef } from '@/types/api';

/**
 * Список прикреплённых файлов.
 *
 * Один компонент на три места: форма добавления, форма редактирования и
 * детальный экран записи. Разводить их нечем — набор строк одинаковый, разнится
 * только наличие кнопки удаления и заголовка колонки.
 *
 * Иконка выбирается по MIME, а не по расширению: расширение приходит от
 * клиента и может врать, а MIME сервер проверяет по белому списку при
 * загрузке.
 *
 * Фото открывается во встроенном InAppBrowser (зум и свайп); PDF — inline в
 * отдельном контексте системного браузера по короткой share-ссылке, чтобы
 * просмотр не навигировал документ PWA. Остальные файлы отдаём системе через
 * share/сохранение. Отдельной кнопки скачивания нет.
 */

/** Потолки повторяют серверные: клиент не должен нагружать пользователя ошибкой
 *  после отправки пяти мегабайт. */
export const MAX_FILES_PER_RECORD = 10;
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

function iconFor(file: ServerFileRef) {
  if (file.mimeType.startsWith('image/')) return FileImage;
  if (file.mimeType === 'application/pdf') return FileText;
  return FileIcon;
}

/** Картинка листается прямо в задании, остальное открывается браузером. */
export function isImageFile(file: ServerFileRef): boolean {
  return file.mimeType.startsWith('image/');
}

/** «84569» → «83 КБ». Человек думает в мегабайтах, а не в байтах. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 КБ';

  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;

  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

/**
 * Проверка файла до загрузки.
 *
 * Проверки здесь — ради подсказки сразу, а не ради безопасности: настоящая
 * проверка размера и типа живёт на сервере, и клиентскую можно обойти, не
 * напрямую обращаясь к API.
 */
export function checkFile(file: File): string | null {
  if (file.size === 0) return `«${file.name}» пустой.`;
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `«${file.name}» больше ${MAX_FILE_SIZE_BYTES / 1024 / 1024} МБ.`;
  }

  return null;
}

export function FileAttachmentList({
  files,
  onRemove,
  removeDisabled,
  emptyHint,
}: {
  files: ServerFileRef[];
  /** Снять файл: из формы (до сохранения) или с записи (PATCH с новым списком). */
  onRemove?: (file: ServerFileRef) => void;
  /** Гуглить кнопку удаления, пока идёт запрос. */
  removeDisabled?: boolean;
  /** Подпись под списком, когда он пуст. */
  emptyHint?: string;
}) {
  /** Индекс открытого файла в этом списке — вьюер листает соседей. */
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  /** Файл, который открываем прямо сейчас: защита от повторного нажатия. */
  const [pdfBusyId, setPdfBusyId] = useState<string | null>(null);
  /** Android: PDF открываем встроенным pdf.js, без скачивания и Chrome. */
  const [pdfViewer, setPdfViewer] = useState<ServerFileRef | null>(null);
  /**
   * Подсказка, если браузер не открыл PDF сам: показываем прямую ссылку, которую
   * человек нажмёт руками. Без неё неудачное открытие выглядело как «ничего не
   * произошло» — именно на это и жаловались.
   */
  const [pdfFallback, setPdfFallback] = useState<{
    file: ServerFileRef;
    url: string | null;
    /** Android/TWA: intent-ссылка в системный Chrome. */
    externalUrl?: string;
    /** true — ссылка скачивает файл (Android), иначе открывает (iOS). */
    download?: boolean;
    error?: string;
  } | null>(null);

  /**
   * PDF открываем системным просмотрщиком (Safari/Chrome), а не своим canvas:
   * на iOS так работает штатный интерфейс PDF с «Поделиться», на Android — это
   * единственный способ, который вообще рисует документ.
   */
  const openPdfFile = useCallback(
    async (file: ServerFileRef) => {
      if (pdfBusyId) return;
      setPdfBusyId(file.fileId);

      try {
        const outcome = await openPdf(file);
        if (outcome.kind === 'fallback') {
          setPdfFallback({
            file,
            url: outcome.url ?? null,
            externalUrl: outcome.externalUrl,
            download: outcome.download,
          });
        }
      } catch (err: unknown) {
        setPdfFallback({ file, url: null, error: pdfOpenErrorText(err) });
      } finally {
        setPdfBusyId(null);
      }
    },
    [pdfBusyId],
  );

  if (files.length === 0) {
    return emptyHint ? (
      <p className="px-1 text-[13px] leading-snug text-[var(--text-tertiary)]">{emptyHint}</p>
    ) : null;
  }

  return (
    <>
      <ul className="space-y-1.5">
        {files.map((file, index) => {
          const Icon = iconFor(file);
          const isImage = isImageFile(file);

          const content = (
            <>
              {isImage ? (
                <FileThumbnail file={file} />
              ) : (
                <Icon size={17} className="shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] leading-snug">{file.originalName}</span>
                <span className="block text-[12px] text-[var(--text-tertiary)]">
                  {isImage || file.mimeType === 'application/pdf'
                    ? 'Нажмите, чтобы открыть'
                    : `${formatBytes(file.size)} · нажмите, чтобы скачать`}
                </span>
              </span>
            </>
          );

          return (
            <li
              key={file.fileId}
              className="surface flex items-center gap-2.5 px-3 py-2"
              style={{ borderRadius: '12px' }}
            >
              <button
                type="button"
                onClick={() => {
                  haptic('light');
                  if (isImage) {
                    // Фото — во встроенный вьюер: зум и свайп по соседям.
                    setOpenIndex(index);
                    return;
                  }
                  if (file.mimeType === 'application/pdf') {
                    // Android: встроенный просмотрщик. iOS и десктоп — как
                    // раньше, системным браузером.
                    if (isAndroid()) {
                      setPdfViewer(file);
                      return;
                    }
                    void openPdfFile(file);
                    return;
                  }
                  // Остальные документы (docx, zip, …) передаём системе: своего
                  // просмотрщика у них нет.
                  void api.downloadFile(file.fileId, file.originalName, file.mimeType);
                }}
                className="pressable flex min-w-0 flex-1 items-center gap-2.5 text-left active:pressable-active"
              >
                {content}
              </button>

              {onRemove ? (
                <button
                  type="button"
                  aria-label={`Убрать ${file.originalName}`}
                  disabled={removeDisabled}
                  onClick={() => {
                    haptic('light');
                    onRemove(file);
                  }}
                  className="pressable shrink-0 rounded-full p-1.5 active:pressable-active disabled:opacity-40"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  <Trash2 size={16} aria-hidden />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {pdfViewer ? (
        <PdfViewerScreen
          file={pdfViewer}
          onClose={() => setPdfViewer(null)}
          onFallback={() => {
            const file = pdfViewer;
            setPdfViewer(null);
            void openPdfFile(file);
          }}
        />
      ) : null}

      <BottomSheet
        open={Boolean(pdfFallback)}
        onClose={() => setPdfFallback(null)}
        title="Документ PDF"
        footer={
          pdfFallback?.url ? (
            <a
              href={pdfFallback.externalUrl ?? pdfFallback.url}
              target={pdfFallback.externalUrl ? undefined : '_blank'}
              rel="noopener noreferrer"
              onClick={() => {
                haptic('light');
                setPdfFallback(null);
              }}
              className="pressable block w-full rounded-[14px] py-3 text-center text-[17px] font-semibold text-white active:pressable-active"
              style={{ background: 'var(--accent)' }}
            >
              {pdfFallback.download ? 'Скачать PDF' : 'Открыть PDF'}
            </a>
          ) : (
            <button
              type="button"
              onClick={() => {
                const target = pdfFallback?.file;
                if (!target) return;
                haptic('medium');
                void api.downloadFile(target.fileId, target.originalName, target.mimeType);
                setPdfFallback(null);
              }}
              className="pressable w-full rounded-[14px] py-3 text-[17px] font-semibold text-white active:pressable-active"
              style={{ background: 'var(--accent)' }}
            >
              Скачать файл
            </button>
          )
        }
      >
        <p className="text-[14px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {pdfFallback?.error ??
            (pdfFallback?.url
              ? pdfFallback.download
                ? `«${pdfFallback.file.originalName}» скачается в «Загрузки» и откроется системным просмотрщиком.`
                : `«${pdfFallback.file.originalName}» откроется в браузере: там документ покажет системный просмотрщик с кнопкой «Поделиться».`
              : 'Документ можно скачать и открыть в системном просмотрщике.')}
        </p>
      </BottomSheet>

      {openIndex !== null && openIndex < files.length ? (
        <InAppBrowser
          files={files}
          initialIndex={openIndex}
          onClose={() => {
            haptic('light');
            setOpenIndex(null);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Кнопка выбора файлов.
 *
 * `input[type=file]` спрятан, а нажатие идёт по кнопке: на iPhone открыть
 * системный выбор файлов можно только по настоящему тапу по элементу формы, и
 * подмена вызова `click()` из обработчика без жеста там работает через раз.
 *
 * Кнопка скрывается сама, когда файлов уже максимум: показывать её и
 * получать отказ «не больше 10 файлов» — обиднее, чем убрать заранее.
 */
export function AttachFileButton({
  disabled,
  full,
  onPick,
}: {
  disabled?: boolean;
  full?: boolean;
  onPick: (files: File[]) => void;
}) {
  if (full) return null;

  return (
    <label
      className={cn(
        'pressable flex w-full items-center justify-center gap-2 rounded-[12px] border border-dashed px-4 py-3 text-[14px] font-medium active:pressable-active',
        disabled && 'pointer-events-none opacity-40',
      )}
      style={{ borderColor: 'var(--separator-soft)', color: 'var(--accent)' }}
    >
      <Upload size={17} aria-hidden />
      Прикрепить файл
      <input
        type="file"
        multiple
        disabled={disabled}
        className="sr-only"
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          // Значение сбрасывается сразу: иначе повторный выбор того же файла
          // не даст события change, и человек не сможет добавить его дважды.
          event.target.value = '';
          if (picked.length > 0) onPick(picked);
        }}
      />
    </label>
  );
}

/** Подсказка про количество и потолок. */
export function FilesHint({ count }: { count: number }) {
  return (
    <p className="flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)]">
      <Paperclip size={12} aria-hidden />
      {count === 0
        ? `До ${MAX_FILES_PER_RECORD} файлов, каждый до ${MAX_FILE_SIZE_BYTES / 1024 / 1024} МБ`
        : `Файлов: ${count} из ${MAX_FILES_PER_RECORD}`}
    </p>
  );
}
