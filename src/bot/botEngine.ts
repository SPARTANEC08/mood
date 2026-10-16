/**
 * Маршрутизация входящих сообщений и нажатий бота.
 *
 * После превращения бота в тонкий push-канал здесь осталось ровно четыре
 * исхода: приветствие, привязка Telegram к существующей записи PWA по адресу
 * из `/start`, включение и выключение уведомлений. Больше бот ничего не
 * умеет — расписание, задания, оценки и почта живут в приложении.
 *
 * Почему привязка идёт по адресу записи, а не по коду. Раньше бот выдавал
 * одноразовый код, PWA обменивала его на токен. Теперь вход в приложение
 * самостоятельный — логин и пароль БАРС, — и код не нужен: Telegram и так
 * подтвердил, кто прислал `/start`, а адрес записи человек открывает в своём
 * же приложении. Токен бота для этого не участвует.
 *
 * Чего модуль НЕ делает принципиально. Он не создаёт запись в базе. Раньше
 * первый `/start` заводил пользователя, и это был единственный путь, которым
 * бота вообще можно было начать пользоваться; теперь запись создаёт PWA при
 * входе логином БАРС, и заводить её боту нечем: ни логина, ни пароля у него
 * нет, а запись без них всё равно ни с чем не связана.
 */

import { userStore, type StoredUser } from '../storage/userStore.ts';
import {
  buildAccountNotFoundView,
  buildAlreadyLinkedView,
  buildNotificationsOffView,
  buildNotificationsOnView,
  buildWelcomeView,
  type BotViewResult,
} from './pwaView.ts';

/** От кого пришло сообщение. */
export interface TelegramSender {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
}

/** Что движку нужно сказать вызывающему коду о том, что показать. */
export interface ProcessResult {
  /** Текст экрана и клавиатура. */
  view: BotViewResult;
  /** Тост Telegram — короткая всплышка над клавиатурой. */
  toast?: string;
}

/**
 * Распознаёт UUID в аргументе `/start`.
 *
 * Проверка строгая и по форме, а не «если не пусто»: адрес приходит из ссылки,
 * её может подправить кто угодно, и молчаливая запись `telegramId` в запись,
 * найденную по мусору, была бы хуже, чем понятный отказ.
 */
const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseStartArgument(text: string): string | null {
  const match = /^\/start(?:@\w+)?\s*(\S+)?/.exec(text.trim());
  const arg = match?.[1]?.trim();

  if (!arg || !USER_ID_RE.test(arg)) return null;

  return arg.toLowerCase();
}

/**
 * Привязывает Telegram к записи приложения.
 *
 * Переезд между аккаунтами обрабатывается здесь же: если этот Telegram уже
 * привязан к другой записи, старая отвязывается. Иначе получилось бы, что у
 * человека две подписки, а выключить одну из них он не может — кнопка
 * «Выключить» в боте работает с той, что нашлась по telegramId, то есть с
 * новой, а старая так и осталась бы включённой молча.
 *
 * Выключение старой записи здесь обязательно, а не «на всякий случай»: без
 * него выключение в боте отключало бы уведомления не у того человека.
 */
function linkTelegram(telegramId: number, userId: string): void {
  const previous = userStore.findUserByTelegramId(telegramId);

  if (previous && previous.userId !== userId) {
    userStore.patchByUserId(previous.userId, {
      telegramId: null,
      notificationsEnabled: false,
    });
  }

  userStore.patchByUserId(userId, { telegramId, notificationsEnabled: true });
}

/** Входящее сообщение: `/start`, `/start <userId>`, `/app` или «мусор». */
export async function processTelegramMessage(
  sender: TelegramSender,
  text: string,
): Promise<ProcessResult> {
  const trimmed = (text ?? '').trim();
  const startArg = parseStartArgument(trimmed);

  if (startArg) {
    const target = userStore.getByUserId(startArg);

    if (!target) {
      return { view: buildAccountNotFoundView() };
    }

    linkTelegram(sender.id, startArg);
    return { view: buildNotificationsOnView() };
  }

  // `/app` и любой другой текст без адреса ведут на приветствие: отдельного
  // экрана для них нет и незачем — показывать нечего.
  const existing = userStore.findUserByTelegramId(sender.id);

  return { view: existing ? buildAlreadyLinkedView() : buildWelcomeView() };
}

/** Нажатие кнопки: `pwa_open`, `notif_off`, `notif_on`, `app_back_to_menu`. */
export async function processTelegramCallback(
  sender: TelegramSender,
  callbackData: string,
): Promise<ProcessResult> {
  const data = (callbackData ?? '').trim();

  if (data === 'notif_off' || data === 'notif_on') {
    const user = userStore.findUserByTelegramId(sender.id);

    if (!user) {
      return {
        view: buildAccountNotFoundView(),
        toast: 'Аккаунт не найден',
      };
    }

    const enabled = data === 'notif_on';
    userStore.patchByUserId(user.userId, { notificationsEnabled: enabled });

    return {
      view: enabled ? buildNotificationsOnView() : buildNotificationsOffView(),
      toast: enabled ? 'Уведомления включены' : 'Уведомления выключены',
    };
  }

  // `pwa_open`, `app_back_to_menu` и всё незнакомое — на приветствие. Отдельный
  // обработчик для них не нужен: показывается ровно тот же экран, а различать
  // их незачем, потому что различать больше нечего.
  const existing: StoredUser | undefined = userStore.findUserByTelegramId(sender.id);

  return { view: existing ? buildAlreadyLinkedView() : buildWelcomeView() };
}