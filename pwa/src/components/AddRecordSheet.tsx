import { useCallback, useEffect, useRef, useState } from 'react';

import {
  AttachFileButton,
  checkFile,
  FileAttachmentList,
  FilesHint,
  MAX_FILES_PER_RECORD,
} from '@/components/FileAttachmentList';
import { BottomSheet } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { haptic, notify } from '@/lib/env';
import type { ApiHomework, ApiImportant, LessonKindType, ServerFileRef } from '@/types/api';

/**
 * Единый диалог для добавления и правки ДЗ и «Важного».
 *
 * Один компонент на четыре сценария — сознательно. Формы совпадают полностью,
 * кроме двух полей, а раздельные компоненты разъехались бы за полгода: правило
 * «файл 20 МБ», порядок «сначала загрузить, потом сохранить» и откат при
 * закрытии должны быть одними и теми же во всех четырёх случаях.
 *
 * ── Порядок при отправке ────────────────────────────────────────────────────
 *
 * 1. Все файлы, которых ещё нет на сервере, загружаются (`POST /api/files/upload`).
 * 2. Запись создаётся или правится с получившимися `fileIds`.
 *
 * Обратный порядок дал бы две проблемы: нельзя было бы приложить файл к
 * правке существующей записи (PATCH принимает только `fileIds`, а не файл), и
 * при откате записи остался бы мусор на диске.
 *
 * ── Что происходит, если человек закрыл диалог ─────────────────────────────
 *
 * Уже загруженные, но не прикреплённые файлы удаляются. Иначе они навсегда
 * заняли бы квоту пользователя (500 МБ) без единой ссылки: `check:files` их
 * не увидит, потому что он обходит записи, а не каталог. Отмена в форме —
 * это «я передумал», и мусор после неё удалять справедливо.
 *
 * Файлы, прикреплённые к уже существующей записи, при отмене НЕ трогаются:
 * они принадлежат записи, а не этой форме.
 */

export type RecordKind = 'homework' | 'important';

export interface AddRecordSheetProps {
  mode: 'create' | 'edit';
  kind: RecordKind;
  initialData?: ApiHomework | ApiImportant;
  /** Для ДЗ при правке: чему равен текст в форме (у объявлений его роль отдельная). */
  onClose: () => void;
  onSuccess: () => void;
}

const KINDS: Array<{ id: LessonKindType; label: string }> = [
  { id: 'lecture', label: 'Лекция' },
  { id: 'practice', label: 'Практика' },
  { id: 'lab', label: 'Лабораторная' },
];

const MAX_HOMEWORK_TEXT = 4000;
const MAX_TITLE = 120;
const MAX_IMPORTANT_TEXT = 8000;

/** Поля, общие для обоих режимов. */
function isHomework(data: ApiHomework | ApiImportant | undefined): data is ApiHomework {
  return Boolean(data && 'discipline' in data);
}

export function AddRecordSheet({
  mode,
  kind: initialKind,
  initialData,
  onClose,
  onSuccess,
}: AddRecordSheetProps) {
  // В режиме правки переключатель записи не нужен: видно, что именно правится,
  // и сменить ДЗ на объявление в том же диалоге — ошибка, а не возможность.
  const [kind, setKind] = useState<RecordKind>(initialKind);

  const [discipline, setDiscipline] = useState(
    initialKind === 'homework' && isHomework(initialData) ? initialData.discipline : '',
  );
  const [lessonKind, setLessonKind] = useState<LessonKindType>(
    initialKind === 'homework' && isHomework(initialData) ? initialData.kind : 'practice',
  );
  const [text, setText] = useState(initialData?.text ?? '');
  const [title, setTitle] = useState(
    initialKind === 'important' && !isHomework(initialData) && initialData
      ? (initialData as ApiImportant).title
      : '',
  );

  /** Файлы, уже лежащие на сервере и прикреплённые к записи (при правке). */
  const [files, setFiles] = useState<ServerFileRef[]>(initialData?.files ?? []);

  /** Файлы, выбранные, но ещё не загруженные. */
  const [pending, setPending] = useState<File[]>([]);

  /** Прогресс текущей загрузки: индекс файла и байты. */
  const [uploading, setUploading] = useState<{ name: string; loaded: number; total: number } | null>(
    null,
  );

  const [subjects, setSubjects] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Состояние загрузки списка предметов.
   *
   * Отдельное состояние, а не пустой массив, потому что «список ещё грузится»,
   * «список не пришёл» и «список пуст» — это три разных состояния, и человеку
   * нужны три разных ответа. Раньше все три выглядели одинаково: select с одной
   * строкой «Выберите предмет» и без единого слова о том, что произошло.
   */
  const [subjectsLoading, setSubjectsLoading] = useState(false);
  const [subjectsError, setSubjectsError] = useState<string | null>(null);
  /** Номер попытки: увеличение перезапускает загрузку по кнопке «Обновить». */
  const [subjectsAttempt, setSubjectsAttempt] = useState(0);

  /**
   * Файлы, загруженные этой формой и ещё не прикреплённые к записи.
   *
   * Отдельное состояние нужно, чтобы отличать «файл этой формы» от «файла,
   * который был в записи до правки»: отменять правку нельзя, а значит чужие
   * (уже прикреплённые) файлы удалять нельзя тем же кодом.
   */
  const uploadedHere = useRef<Set<string>>(new Set());
  const closed = useRef(false);

  // ── Предметы для выбора ──────────────────────────────────────────────────
  //
  // Список берётся из расписания, а не из существующих ДЗ: предмет, по которому
  // ещё никто ничего не выкладывал, в списке из ДЗ отсутствует и его нельзя
  // было бы выбрать — то есть добавить первое задание по предмету было нельзя.
  useEffect(() => {
    let cancelled = false;

    setSubjectsLoading(true);
    setSubjectsError(null);

    void api
      .subjects()
      .then((res) => {
        if (cancelled) return;

        // В форме правки предмет уже выбран, и его может не оказаться в списке
        // (семестр сменился). Тогда добавляем его — иначе select молча
        // показывал бы «пусто» и человек стёр бы предмет, не заметив.
        if (initialKind === 'homework' && isHomework(initialData) && !res.items.includes(initialData.discipline)) {
          setSubjects([...res.items, initialData.discipline].sort());
        } else {
          setSubjects(res.items);
        }
      })
      .catch((err: unknown) => {
        // Молча проглатывать здесь нельзя. /api/subjects отдаёт 503, когда
        // расписание недоступно, и 401, когда истекла сессия БАРС, — а форма
        // выглядела при этом как «список пуст», и человек гадал, что не так с
        // приложением.
        console.error('[AddRecordSheet] список предметов не загрузился:', err);

        if (cancelled) return;

        setSubjectsError(
          err instanceof Error && err.message
            ? err.message
            : 'Не удалось загрузить список предметов.',
        );

        // Критично только для выбора предмета: без списка form всё равно
        // останется доступным для правки существующего задания.
        if (isHomework(initialData)) setSubjects([initialData.discipline]);
      })
      .finally(() => {
        if (!cancelled) setSubjectsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [initialKind, initialData, subjectsAttempt]);

  // ── Откат неприкреплённых файлов ─────────────────────────────────────────
  //
  // Срабатывает и при закрытии, и при размонтировании: оба случая означают,
  // что запись не создана, а значит загруженные файлы никому не принадлежат.
  useEffect(() => {
    return () => {
      if (closed.current) return;

      for (const fileId of uploadedHere.current) {
        void api.deleteFile(fileId).catch(() => {
          // Файл уже удалён или запись успела сохраниться — ничего страшного.
        });
      }
    };
  }, []);

  const close = useCallback(() => {
    closed.current = true;
    onClose();
  }, [onClose]);

  /** Загрузка одного файла с отчётом о прогрессе. */
  const uploadOne = useCallback(async (file: File): Promise<ServerFileRef> => {
    const uploaded = await api.uploadFile(file, (loaded, total) => {
      setUploading({ name: file.name, loaded, total });
    });

    uploadedHere.current.add(uploaded.fileId);
    return uploaded;
  }, []);

  /** Выбор файлов: сначала проверка всех, потом загрузка по очереди. */
  const pickFiles = useCallback(
    async (picked: File[]) => {
      setError(null);

      const room = MAX_FILES_PER_RECORD - files.length - pending.length;
      if (room <= 0) {
        setError(`К записи можно прикрепить не больше ${MAX_FILES_PER_RECORD} файлов.`);
        return;
      }

      // Проверяем всё до начала загрузки: иначе человек увидит, как три файла
      // загрузились, а четвёртый отскочил с ошибкой — и поймёт это как сбой.
      const problems: string[] = [];
      for (const file of picked) {
        const issue = checkFile(file);
        if (issue) problems.push(issue);
      }

      if (problems.length > 0) {
        setError(problems[0]);
        return;
      }

      const accepted = picked.slice(0, room);
      const dropped = picked.length - accepted.length;

      setPending(accepted);
      setUploading({ name: accepted[0].name, loaded: 0, total: accepted[0].size });

      try {
        // По очереди, а не параллельно: на мобильном интернете пять одновременных
        // загрузок делят канал и все идут медленнее, а прогресс в интерфейсе
        // всё равно показывается по одному файлу.
        const uploaded: ServerFileRef[] = [];
        for (const file of accepted) uploaded.push(await uploadOne(file));

        setFiles((prev) => [...prev, ...uploaded]);
      } catch (err: unknown) {
        // Уже загруженное в этом же вызове убираем: иначе оно осталось бы
        // прикреплённым к записи, которую человек так и не создал.
        const uploaded = [...uploadedHere.current];
        for (const fileId of uploaded) {
          await api.deleteFile(fileId).catch(() => {});
          uploadedHere.current.delete(fileId);
        }

        setFiles((prev) => prev.filter((f) => !uploaded.includes(f.fileId)));
        setError(err instanceof ApiError ? err.message : 'Не удалось загрузить файл.');
      } finally {
        setPending([]);
        setUploading(null);

        if (dropped > 0) {
          setError(`Прикреплено ${accepted.length} из ${picked.length}: лимит ${MAX_FILES_PER_RECORD}.`);
        }
      }
    },
    [files.length, pending.length, uploadOne],
  );

  /** Снять файл с формы. */
  const removeFile = useCallback((file: ServerFileRef) => {
    setFiles((prev) => prev.filter((f) => f.fileId !== file.fileId));

    // Файл этой формы удаляем с сервера сразу: он ещё ни к чему не привязан.
    // Файл из существующей записи не трогаем — он исчезнет с сервера вместе с
    // записью, когда сервер сохранит новый состав (PATCH).
    if (!uploadedHere.current.has(file.fileId)) return;

    uploadedHere.current.delete(file.fileId);
    void api.deleteFile(file.fileId).catch(() => {});
  }, []);

  // ── Отправка ─────────────────────────────────────────────────────────────
  const canSubmit =
    !busy &&
    !uploading &&
    pending.length === 0 &&
    (kind === 'homework'
      ? Boolean(discipline) && (text.trim().length > 0 || files.length > 0)
      : title.trim().length > 0);

  const submit = useCallback(async () => {
    if (!canSubmit) return;

    setBusy(true);
    setError(null);

    const fileIds = files.map((f) => f.fileId);

    try {
      if (kind === 'homework') {
        if (mode === 'edit' && initialData) {
          await api.updateHomework(initialData.id, { text: text.trim(), fileIds });
        } else {
          await api.createHomework({
            discipline,
            kind: lessonKind,
            text: text.trim(),
            fileIds,
          });
        }
      } else {
        if (mode === 'edit' && initialData) {
          await api.updateImportant(initialData.id, {
            title: title.trim(),
            text: text.trim(),
            fileIds,
          });
        } else {
          await api.createImportant({ title: title.trim(), text: text.trim(), fileIds });
        }
      }

      // Файлы перешли в запись — теперь за них отвечает сервер, и откат при
      // закрытии диалога их трогать не должен.
      uploadedHere.current.clear();

      notify('success');
      closed.current = true;
      onSuccess();
    } catch (err: unknown) {
      notify('error');
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить. Попробуйте ещё раз.');
      setBusy(false);
    }
  }, [
    canSubmit,
    kind,
    mode,
    initialData,
    text,
    title,
    discipline,
    lessonKind,
    files,
    onSuccess,
  ]);

  const textLimit = kind === 'homework' ? MAX_HOMEWORK_TEXT : MAX_IMPORTANT_TEXT;
  const overLimit = text.length > textLimit;

  const titleText =
    mode === 'edit' ? 'Изменить' : kind === 'homework' ? 'Новое задание' : 'Новое объявление';

  return (
    <BottomSheet
      open
      title={titleText}
      onClose={close}
      footer={
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => {
            haptic('medium');
            void submit();
          }}
          className="pressable mt-4 w-full rounded-[14px] px-4 py-3.5 text-[16px] font-semibold text-white active:pressable-active disabled:opacity-40"
          style={{ background: 'var(--accent)' }}
        >
          {busy ? 'Сохраняем…' : uploading ? 'Загружаем файл…' : mode === 'edit' ? 'Сохранить' : 'Добавить'}
        </button>
      }
    >
      {mode === 'create' ? (
        <div
          role="tablist"
          aria-label="Что добавляем"
          className="mb-4 flex gap-1.5 rounded-[14px] p-1"
          style={{ background: 'var(--surface-grouped)' }}
        >
          {(
            [
              { id: 'homework', label: 'ДЗ' },
              { id: 'important', label: 'Важное' },
            ] as Array<{ id: RecordKind; label: string }>
          ).map((tab) => {
            const isActive = tab.id === kind;

            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => {
                  haptic('light');
                  setKind(tab.id);
                  setError(null);
                }}
                className="pressable flex-1 rounded-[10px] py-2 text-[14px] font-medium transition-colors active:pressable-active"
                style={{
                  background: isActive ? 'var(--surface)' : 'transparent',
                  color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                  boxShadow: isActive ? 'var(--shadow-card)' : 'none',
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="space-y-3 pb-1">
        {kind === 'homework' ? (
          <>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-[var(--text-secondary)]">
                Предмет
              </span>
              {mode === 'edit' ? (
                // При правке предмет не меняется: запись привязана к конкретной
                // паре расписания, и смена дисциплины оставила бы дату и номер
                // пары при предмете, к которому они не относятся.
                <div className="rounded-[12px] border border-[var(--separator-soft)] px-3 py-2.5 text-[15px] opacity-70">
                  {discipline}
                </div>
              ) : (
                <select
                  value={discipline}
                  onChange={(event) => setDiscipline(event.target.value)}
                  className="w-full rounded-[12px] border border-[var(--separator-soft)] bg-[var(--surface)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                >
                  <option value="">Выберите предмет</option>
                  {subjects.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              )}
</label>

            {/*
              Обратная связь по списку предметов.

              Раньше здесь стоял только select, поэтому любой сбой — 503 от
              ts.mpei.ru, истёкшая сессия БАРС, оборванная сеть — выглядел как
              «в списке нет ни одного предмета». Теперь каждое из трёх состояний
              говорит о себе: ошибка видна и предлагает повтор, пустой ответ
              предлагает заглянуть в расписание.
            */}
            {mode === 'create' && subjectsError ? (
              <div className="mt-1.5 flex items-start gap-2">
                <p className="flex-1 text-[12px] leading-snug text-[var(--danger)]">
                  {subjectsError} Потяните список вниз или нажмите «Обновить».
                </p>
                <button
                  type="button"
                  onClick={() => setSubjectsAttempt((n) => n + 1)}
                  className="pressable shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium active:pressable-active"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                >
                  Обновить
                </button>
              </div>
            ) : null}

            {mode === 'create' && !subjectsError && !subjectsLoading && subjects.length === 0 ? (
              <div className="mt-1.5 flex items-start gap-2">
                <p className="flex-1 text-[12px] leading-snug text-[var(--text-tertiary)]">
                  Список предметов пуст — загляните в расписание: возможно, группа
                  ещё не выгружена.
                </p>
                <button
                  type="button"
                  onClick={() => setSubjectsAttempt((n) => n + 1)}
                  className="pressable shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium active:pressable-active"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                >
                  Обновить
                </button>
              </div>
            ) : null}

            {mode === 'create' && subjectsLoading && subjects.length === 0 ? (
              <p className="mt-1.5 text-[12px] text-[var(--text-tertiary)]">Загружаю предметы…</p>
            ) : null}

            {mode === 'create' ? (
              <div>
                <span className="mb-1.5 block text-[13px] font-medium text-[var(--text-secondary)]">
                  Тип пары
                </span>
                <div
                  role="radiogroup"
                  aria-label="Тип пары"
                  className="flex gap-1.5 rounded-[12px] p-1"
                  style={{ background: 'var(--surface-grouped)' }}
                >
                  {KINDS.map((item) => {
                    const isActive = item.id === lessonKind;

                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="radio"
                        aria-checked={isActive}
                        onClick={() => {
                          haptic('light');
                          setLessonKind(item.id);
                        }}
                        className="pressable flex-1 rounded-[9px] py-2 text-[13px] font-medium transition-colors active:pressable-active"
                        style={{
                          background: isActive ? 'var(--surface)' : 'transparent',
                          color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                          boxShadow: isActive ? 'var(--shadow-card)' : 'none',
                        }}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-[var(--text-secondary)]">
              Заголовок
            </span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Например: Собрание старостата"
              maxLength={MAX_TITLE}
              enterKeyHint="next"
              className="w-full rounded-[12px] border border-[var(--separator-soft)] bg-[var(--surface)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
            <span className="mt-1 block text-right text-[11px] text-[var(--text-tertiary)]">
              {title.length} / {MAX_TITLE}
            </span>
          </label>
        )}

        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-[var(--text-secondary)]">
            {kind === 'homework' ? 'Задание' : 'Текст'}
          </span>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={
              kind === 'homework'
                ? 'Что нужно сделать. Можно оставить пустым, если приложили файл.'
                : 'Подробности. Можно оставить пустым, если приложили файл.'
            }
            maxLength={textLimit}
            rows={4}
            className="w-full resize-none rounded-[12px] border border-[var(--separator-soft)] bg-[var(--surface)] px-3 py-2.5 text-[15px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <span
            className="mt-1 block text-right text-[11px]"
            style={{ color: overLimit ? 'var(--danger)' : 'var(--text-tertiary)' }}
          >
            {text.length} / {textLimit}
          </span>
        </label>

        <div className="space-y-2 pt-1">
          <FilesHint count={files.length + pending.length} />

          <FileAttachmentList files={files} onRemove={removeFile} removeDisabled={busy} />

          {uploading ? (
            <div className="rounded-[12px] border border-[var(--separator-soft)] px-3 py-2.5">
              <p className="truncate text-[13px] text-[var(--text-secondary)]">{uploading.name}</p>
              <div
                className="mt-1.5 h-1 overflow-hidden rounded-full"
                style={{ background: 'var(--separator-soft)' }}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-150"
                  style={{
                    width: `${Math.min(100, Math.round((uploading.loaded / uploading.total) * 100))}%`,
                    background: 'var(--accent)',
                  }}
                />
              </div>
            </div>
          ) : null}

          <AttachFileButton
            disabled={busy || Boolean(uploading)}
            full={files.length + pending.length >= MAX_FILES_PER_RECORD}
            onPick={(picked) => void pickFiles(picked)}
          />
        </div>

        {error ? (
          <p className="pt-1 text-[13px] leading-snug text-[var(--danger)]">{error}</p>
        ) : null}
      </div>
    </BottomSheet>
  );
}
