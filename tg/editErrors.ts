/**
 * Классификация ошибок правки сообщения Telegram.
 *
 * Вынесено из telegramService, чтобы покрыть тестом: именно на этом месте
 * ломалась одностраничность — «message is not modified» приводил к отправке
 * второй копии меню, а сообщение-документ нельзя было превратить в текст.
 */

export type EditErrorKind = 'not_modified' | 'not_editable' | 'other';

export function classifyEditError(error: unknown): EditErrorKind {
  const raw =
    (error as { description?: string })?.description ??
    (error instanceof Error ? error.message : String(error ?? ''));
  const description = raw.toLowerCase();

  if (description.includes('message is not modified')) return 'not_modified';

  if (
    description.includes('no text in the message to edit') ||
    description.includes("message can't be edited") ||
    description.includes('message can not be edited') ||
    description.includes('message to edit not found')
  ) {
    return 'not_editable';
  }

  return 'other';
}
