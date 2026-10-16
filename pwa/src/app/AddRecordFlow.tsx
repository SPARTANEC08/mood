/**
 * Диалог добавления записи (ДЗ или «Важное»), общий для всех вкладок.
 *
 * Плюсик есть на панели в любой вкладке, поэтому диалог живёт над страницами, а
 * не внутри «Заданий». Компонент тонкий: сам он ничего не решает про данные —
 * только показывает `AddRecordSheet` и отдаёт наружу факт успешного сохранения,
 * чтобы оболочка подняла счётчик обновления списков.
 */

import { AddRecordSheet, type RecordKind } from '@/components/AddRecordSheet';

export function AddRecordFlow({
  open,
  kind,
  onClose,
  onSaved,
}: {
  open: boolean;
  kind: RecordKind;
  onClose: () => void;
  /** Запись сохранена: оболочка обновит списки и перейдёт на «Задания». */
  onSaved: () => void;
}) {
  if (!open) return null;

  return <AddRecordSheet mode="create" kind={kind} onClose={onClose} onSuccess={onSaved} />;
}
