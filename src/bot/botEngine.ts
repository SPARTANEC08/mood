import { clearScheduleCache, getGroupSchedule } from './scheduleCache.ts';
import { ParsedSchedule } from '../parser/types.ts';
import { HomeworkRecord, homeworkStore, TelegramFileRef } from '../storage/homeworkStore.ts';
import { ImportantMessage, importantStore } from '../storage/importantStore.ts';
import { isBarsAuthorized, TelegramUser, userStore } from '../storage/userStore.ts';
import { OsepMailClient } from '../services/mail/osepMailClient.js';
import { markActive } from '../services/notifications/pollSchedule.js';
import { SessionExpiredError } from '../services/bars/barsClient.js';
import { formatDisplayDate } from '../utils/time.ts';
import { b, code, esc, i, quote, RULE, toneButton, truncate } from './format.ts';
import {
  createBarsServiceForUser,
  hasPendingTwoFactor,
  isBarsSessionValid,
  isLoginInFlight,
  readBarsCredentials,
  resetAuthFlow,
  startBarsLogin,
  submitTwoFactorCode,
} from './authFlow.ts';
import {
  buildBarsConnectingView,
  buildLoginPromptView,
  buildLogoutView,
  buildPasswordPromptView,
} from './authView.ts';
import { buildHomework, looksLikeHomework } from './homeworkManager.ts';
import {
  buildConfirmDeleteView,
  buildHomeworkListView,
  buildImportantAddPromptView,
  buildImportantDetailView,
  buildImportantListView,
  buildSingleHomeworkDetailView,
} from './importantView.ts';
import {
  buildAttendanceView,
  buildGradesView,
  buildLibraryView,
  buildMoreHubView,
  buildOrdersView,
  buildOsepView,
  buildServiceErrorView,
} from './moreView.ts';
import {
  buildMainScheduleView,
  buildSubjectDetailView,
  getRandomLunchJoke,
  InlineButton,
} from './scheduleView.ts';

export interface TelegramSender {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
}

export interface ProcessMessageResult {
  action: 'edit' | 'send';
  messageText: string;
  keyboard?: InlineButton[][];
  deleteIncoming: boolean;
  user: TelegramUser | null;
  /**
   * need_login — требуется вход в БАРС (шаг логина/пароля/2FA),
   * registered — пользователь авторизован, доступны расписание и сервисы.
   */
  status: 'need_login' | 'registered';
  notice?: string;
  toast?: string;
  filesToSend?: TelegramFileRef[];
  newHomeworkCreated?: HomeworkRecord;
  newImportantCreated?: ImportantMessage;
  deletedChannelMessageIds?: number[];
}

/**
 * Пользователи, от которых бот ждёт свободный текст для «Важного».
 *
 * Раньше это был голый Set: запись появлялась по кнопке и удалялась только
 * в семи местах обработчика. Если пользователь нажал «Добавить» и пропал,
 * его ID оставался в Set навсегда — а вместе с ним и ветка «пользователь
 * сейчас вводит текст», в которую он больше никогда не попадёт.
 *
 * Теперь это Map с временем ожидания: запись живёт 30 минут, по прошествии
 * которых считается брошенной.
 */
const waitingForImportantText = new Map<number, number>();

/** Сколько ждём текст, прежде чем считать ввод брошенным. */
const IMPORTANT_TEXT_TTL_MS = 30 * 60 * 1000;

/** Периодическая уборка брошенных записей. */
const IMPORTANT_SWEEP_MS = 5 * 60 * 1000;

/**
 * Помечает пользователя как ожидающего текст и продлевает ожидание.
 */
function markWaitingForImportantText(userId: number, now: number = Date.now()): void {
  waitingForImportantText.set(userId, now + IMPORTANT_TEXT_TTL_MS);
}

/**
 * Проверяет, ждём ли от пользователя текст, и снимает ожидание.
 *
 * Снятие происходит только когда ожидание действительно закончилось: пользователь
 * прислал текст или сказал «отмена». Раньше здесь был `Set.has()`, который не
 * менял состояние, и `delete` стоял внутри двух веток — пустое сообщение
 * оставляло режим ввода включённым. Это поведение сохранено.
 */
function isWaitingForImportantText(userId: number, now: number = Date.now()): boolean {
  const expiresAt = waitingForImportantText.get(userId);
  if (expiresAt === undefined) return false;
  // Запись без времени (старая сериализация) считаем действующей.
  if (expiresAt !== 0 && now >= expiresAt) {
    waitingForImportantText.delete(userId);
    return false;
  }
  return true;
}

/**
 * Явно снимает ожидание: пользователь прислал текст или отменил ввод.
 */
function clearWaitingForImportantText(userId: number): void {
  waitingForImportantText.delete(userId);
}

/**
 * Убирает записи, по которым текст так и не пришёл.
 */
function sweepWaitingForImportantText(now: number = Date.now()): void {
  for (const [userId, expiresAt] of waitingForImportantText) {
    if (now >= expiresAt) waitingForImportantText.delete(userId);
  }
}

/** Таймер уборки: процесс не должен им удерживаться. */
const importantSweepTimer = setInterval(sweepWaitingForImportantText, IMPORTANT_SWEEP_MS);
importantSweepTimer.unref?.();

export async function getCachedSchedule(user: TelegramUser): Promise<ParsedSchedule> {
  if (typeof user.groupId !== 'number' || user.groupId <= 0) {
    throw new Error('Группа не определена. Выполните вход через БАРС МЭИ заново.');
  }
  if (!user.groupName) {
    throw new Error('Название группы не определено.');
  }

  return getGroupSchedule(user.groupId, user.groupName, user.faculty);
}

function buildAddHwInstructionView(): { text: string; keyboard: InlineButton[][] } {
  const text = [
    `📝 ${b('Добавление ДЗ')}`,
    '',
    'Отправьте домашнее задание сообщением или файлом.',
    '',
    RULE,
    `${b('Формат')}: ${code('предмет')} ${code('л/п/лаб')} ${code('текст')}`,
    '',
    quote(
      [
        `${esc('Пример:')}`,
        `${esc('Матан')} ${esc('п')} ${esc('№1-5 стр. 20')}`,
        '',
        `${esc('л')} — ${esc('лекция')}`,
        `${esc('п')} — ${esc('практика')}`,
        `${esc('лаб')} — ${esc('лабораторная')}`,
      ].join('\n'),
    ),
  ].join('\n');

  return {
    text,
    keyboard: [[toneButton('◀️ К расписанию', 'back', 'day:current')]],
  };
}

/**
 * Шаг 1 воронки: принимает логин.
 */
function handleLoginInput(sender: TelegramSender, user: TelegramUser, text: string): ProcessMessageResult {
  const login = text.replace(/^\/start\s*/i, '').trim();

  if (!login) {
    const view = buildLoginPromptView(sender.firstName);
    return {
      action: 'edit',
      messageText: view.text,
      keyboard: view.keyboard,
      deleteIncoming: true,
      user,
      status: 'need_login',
    };
  }

  userStore.patch(sender.id, {
    authState: 'AWAIT_PASSWORD',
    tempAuthData: { login },
  });

  const view = buildPasswordPromptView(login);
  return {
    action: 'edit',
    messageText: view.text,
    keyboard: view.keyboard,
    deleteIncoming: true,
    user: userStore.get(sender.id) ?? user,
    status: 'need_login',
  };
}

/**
 * Шаг 2 воронки: принимает пароль и запускает вход в БАРС МЭИ в фоне.
 */
function handlePasswordInput(
  sender: TelegramSender,
  user: TelegramUser,
  password: string
): ProcessMessageResult {
  const login = user.tempAuthData?.login;

  if (!login) {
    const view = buildLoginPromptView(sender.firstName);
    userStore.patch(sender.id, { authState: 'AWAIT_LOGIN', tempAuthData: undefined });
    return {
      action: 'edit',
      messageText: view.text,
      keyboard: view.keyboard,
      deleteIncoming: true,
      user,
      status: 'need_login',
    };
  }

  // Пароль не пишется в users.json — только логин
  userStore.patch(sender.id, { authState: 'AWAIT_PASSWORD', tempAuthData: { login } });

  // Запускаем вход в фоне: следующий экран придёт из authFlow через listener
  const updated = userStore.get(sender.id) ?? user;
  startBarsLogin(updated, login, password);

  return {
    action: 'edit',
    messageText: buildBarsConnectingView(login).text,
    keyboard: [],
    deleteIncoming: true,
    user: updated,
    status: 'need_login',
  };
}

/**
 * Шаг 3 воронки: принимает код 2FA.
 */
function handleTwoFactorInput(user: TelegramUser, code: string): ProcessMessageResult {
  const accepted = submitTwoFactorCode(user, code);

  if (!accepted) {
    userStore.patch(user.telegramId, { authState: 'AWAIT_LOGIN', tempAuthData: undefined });
    const view = buildLoginPromptView(user.firstName, 'Сессия входа истекла. Начните заново.');
    return {
      action: 'edit',
      messageText: view.text,
      keyboard: view.keyboard,
      deleteIncoming: true,
      user,
      status: 'need_login',
    };
  }

  return {
    action: 'edit',
    messageText: `⏳ ${b('Проверяем код подтверждения...')}`,
    keyboard: [],
    deleteIncoming: true,
    user,
    status: 'need_login',
  };
}

export async function processTelegramMessage(
  sender: TelegramSender,
  rawText: string,
  attachedFiles: TelegramFileRef[] = []
): Promise<ProcessMessageResult> {
  const text = (rawText || '').trim();
  const lower = text.toLowerCase();
  const existingUser = userStore.get(sender.id);
  const authorName = [sender.firstName, sender.lastName].filter(Boolean).join(' ') || sender.username || 'Студент';

  // Активность определяет частоту фонового опроса: не заходил дольше 48 ч —
  // нотификатор опрашивает его источники в 18 раз реже.
  markActive(sender.id);

  // 0. Гейт авторизации: без входа в БАРС расписание и сервисы недоступны
  if (!isBarsAuthorized(existingUser)) {
    const user = existingUser ?? userStore.ensureUser(sender.id, {
      firstName: sender.firstName,
      lastName: sender.lastName,
      username: sender.username,
      authState: 'AWAIT_LOGIN',
    });

    const isCancel = lower === 'отмена' || lower === '/cancel';
    const step = user.authState ?? 'AWAIT_LOGIN';

    if (isCancel) {
      resetAuthFlow(sender.id);
      const fresh = userStore.get(sender.id) ?? user;
      const view = buildLoginPromptView(sender.firstName);
      return {
        action: 'edit',
        messageText: view.text,
        keyboard: view.keyboard,
        deleteIncoming: true,
        user: fresh,
        status: 'need_login',
      };
    }

    // Если вход уже выполняется — не принимаем новые данные
    if (step === 'AWAIT_2FA' && hasPendingTwoFactor(sender.id)) {
      return handleTwoFactorInput(user, text);
    }
    if (step === 'AWAIT_2FA' || isLoginInFlight(sender.id)) {
      return {
        action: 'edit',
        messageText: `⏳ ${b('Авторизация уже выполняется')}\n${i('Дождитесь завершения.')}`,
        keyboard: [],
        deleteIncoming: true,
        user,
        status: 'need_login',
      };
    }

    if (step === 'AWAIT_PASSWORD') {
      // Пустой ввод или /start на шаге пароля — возвращаем к логину
      if (!text || lower === '/start') {
        const view = buildLoginPromptView(sender.firstName);
        userStore.patch(sender.id, { authState: 'AWAIT_LOGIN', tempAuthData: undefined });
        return {
          action: 'edit',
          messageText: view.text,
          keyboard: view.keyboard,
          deleteIncoming: true,
          user,
          status: 'need_login',
        };
      }
      return handlePasswordInput(sender, user, text);
    }

    return handleLoginInput(sender, user, text);
  }

  // Здесь пользователь гарантированно авторизован: isBarsAuthorized() отсекает undefined выше
  const currentUser: TelegramUser = existingUser as TelegramUser;
  const groupName = currentUser.groupName ?? '';

  // 1. Режим ввода важного объявления
  if (isWaitingForImportantText(sender.id)) {
    if (lower === 'отмена' || lower.includes('отмен') || lower === '/start') {
      clearWaitingForImportantText(sender.id);
      const impView = buildImportantListView(groupName);
      return {
        action: 'edit',
        messageText: impView.text,
        keyboard: impView.keyboard,
        deleteIncoming: true,
        user: currentUser,
        status: 'registered',
      };
    }

    if (text || attachedFiles.length > 0) {
      clearWaitingForImportantText(sender.id);
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const firstLine = lines[0] || (attachedFiles[0] ? `Файл: ${attachedFiles[0].fileName}` : 'Объявление');
      const title = firstLine.length > 35 ? firstLine.slice(0, 32) + '...' : firstLine;

      const newImp: ImportantMessage = {
        id: `imp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        groupName,
        title,
        text: text || 'См. прикрепленный файл.',
        files: attachedFiles,
        authorName,
        authorId: sender.id,
        createdAt: new Date().toISOString(),
      };

      importantStore.save(newImp);
      const impView = buildImportantListView(groupName);

      return {
        action: 'edit',
        messageText: impView.text,
        keyboard: impView.keyboard,
        deleteIncoming: true,
        user: currentUser,
        status: 'registered',
        toast: 'Объявление добавлено!',
        newImportantCreated: newImp,
      };
    }
  }

  // 2. Раздел ДЗ
  if (lower === 'дз' || lower === 'домашнее задание' || lower.includes('дз') || lower.includes('домашка')) {
    const hwView = buildHomeworkListView(groupName);
    return {
      action: 'edit',
      messageText: hwView.text,
      keyboard: hwView.keyboard,
      deleteIncoming: true,
      user: currentUser,
      status: 'registered',
    };
  }

  // 3. Раздел «Остальное»
  if (lower === 'остальное' || lower === '⚙️ остальное' || lower === 'ещё' || lower === 'еще') {
    const moreView = buildMoreHubView(currentUser);
    return {
      action: 'edit',
      messageText: moreView.text,
      keyboard: moreView.keyboard,
      deleteIncoming: true,
      user: currentUser,
      status: 'registered',
    };
  }

  // 4. Раздел «Важное»
  if (lower === 'важное' || lower === 'важные' || lower.includes('важн') || lower.includes('объявлен')) {
    const impView = buildImportantListView(groupName);
    return {
      action: 'edit',
      messageText: impView.text,
      keyboard: impView.keyboard,
      deleteIncoming: true,
      user: currentUser,
      status: 'registered',
    };
  }

  // 5. Добавление ДЗ
  const isDzCommand = text === '/dz' || lower === '➕ добавить дз' || lower === 'добавить дз';
  const isDzWithContent = looksLikeHomework(text) || (attachedFiles.length > 0 && (looksLikeHomework(text) || text.length > 0));

  if (isDzCommand && !attachedFiles.length) {
    const promptView = buildAddHwInstructionView();
    return {
      action: 'edit',
      messageText: promptView.text,
      keyboard: promptView.keyboard,
      deleteIncoming: true,
      user: currentUser,
      status: 'registered',
    };
  }

  if (isDzWithContent) {
    try {
      const schedule = await getCachedSchedule(currentUser);
      const addResult = buildHomework(currentUser, authorName, schedule, text, attachedFiles);

      if (addResult.success) {
        homeworkStore.save(addResult.record);
        const updatedView = buildMainScheduleView(schedule, addResult.lesson.day.rawDate, currentUser);
        const displayDate = formatDisplayDate(addResult.record.targetDate);

        return {
          action: 'edit',
          messageText: updatedView.text,
          keyboard: updatedView.keyboard,
          deleteIncoming: true,
          user: currentUser,
          status: 'registered',
          toast: `ДЗ сохранено на ${displayDate}!`,
          newHomeworkCreated: addResult.record,
        };
      }

      return {
        action: 'edit',
        messageText: [
          `⚠️ ${b('Не удалось добавить ДЗ')}`,
          '',
          quote(esc(truncate(addResult.error, 240))),
        ].join('\n'),
        keyboard: [
          [toneButton('🔄 Инструкция', 'homework', 'prompt_dz')],
          [toneButton('◀️ К расписанию', 'back', 'day:current')],
        ],
        deleteIncoming: true,
        user: currentUser,
        status: 'registered',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        action: 'edit',
        messageText: [
          `⚠️ ${b('Ошибка при добавлении ДЗ')}`,
          '',
          quote(esc(truncate(msg, 240))),
        ].join('\n'),
        keyboard: [[toneButton('◀️ К расписанию', 'back', 'day:current')]],
        deleteIncoming: true,
        user: currentUser,
        status: 'registered',
      };
    }
  }

  // 6. /reflash — принудительное обновление расписания из ts.mpei.ru
  if (lower === '/reflash' || lower.startsWith('/reflash@')) {
    return await buildReflashView(currentUser);
  }

  // 7. Обычный показ расписания
  try {
    const schedule = await getCachedSchedule(currentUser);
    const view = buildMainScheduleView(schedule, undefined, currentUser);

    return {
      action: 'edit',
      messageText: view.text,
      keyboard: view.keyboard,
      deleteIncoming: true,
      user: currentUser,
      status: 'registered',
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      action: 'edit',
      messageText: [
        `⚠️ ${b('Не удалось загрузить расписание')}`,
        '',
        quote(esc(truncate(msg, 240))),
      ].join('\n'),
      keyboard: [[{ text: '🔄 Попробовать снова', callback_data: 'refresh_schedule' }]],
      deleteIncoming: true,
      user: currentUser,
      status: 'registered',
    };
  }
}

/**
 * Принудительное обновление расписания из ts.mpei.ru.
 * Используется кнопкой «Обновить» и командой /reflash.
 */
export async function buildReflashView(user: TelegramUser): Promise<ProcessMessageResult> {
  // Сбрасываем кэш, иначе повторный запрос не увидит новых данных
  clearScheduleCache(user.groupId);

  try {
    const started = Date.now();
    const schedule = await getCachedSchedule(user);
    const view = buildMainScheduleView(schedule, undefined, user);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    return {
      action: 'edit',
      messageText: view.text,
      keyboard: view.keyboard,
      deleteIncoming: true,
      user,
      status: 'registered',
      toast: `Расписание обновлено за ${seconds} с.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      action: 'edit',
      messageText: [
        `⚠️ ${b('Не удалось обновить расписание')}`,
        '',
        quote(esc(truncate(msg, 240))),
      ].join('\n'),
      keyboard: [
        [toneButton('🔄 Повторить', 'neutral', 'refresh_schedule')],
        [toneButton('⚙️ Остальное', 'more', 'nav_more')],
      ],
      deleteIncoming: true,
      user,
      status: 'registered',
    };
  }
}

/**
 * Роутинг сервисных разделов личного кабинета БАРС и почты ОСЭП.
 */
async function handleServiceCallback(
  sender: TelegramSender,
  user: TelegramUser,
  callbackData: string
): Promise<ProcessMessageResult> {
  const base: Omit<ProcessMessageResult, 'messageText' | 'keyboard'> = {
    action: 'edit',
    deleteIncoming: false,
    user,
    status: 'registered',
  };

  // Почта ОСЭП: использует расшифрованные креды БАРС (единая учётная запись)
  if (callbackData === 'svc_osep') {
    try {
      const { login, password } = readBarsCredentials(user);
      const mail = new OsepMailClient({ user: login, pass: password });

      const status = await mail.getInboxStatus();
      const messages = await mail.fetchMessages({ onlyUnread: true, limit: 8 });

      const view = buildOsepView(messages, status.unseen);
      return { ...base, messageText: view.text, keyboard: view.keyboard };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const view = buildServiceErrorView('ОСЭП', msg);
      return { ...base, messageText: view.text, keyboard: view.keyboard };
    }
  }

  try {
    const service = await createBarsServiceForUser(user);
    const scraper = service.getScraper();

    if (callbackData === 'svc_grades') {
      const grades = await scraper.getCurrentSemesterGrades();
      const view = buildGradesView(grades);
      return { ...base, messageText: view.text, keyboard: view.keyboard };
    }

    if (callbackData === 'svc_attendance') {
      const attendance = await scraper.getAttendance();
      const view = buildAttendanceView(attendance);
      return { ...base, messageText: view.text, keyboard: view.keyboard };
    }

    if (callbackData === 'svc_library') {
      const books = await scraper.getLibraryBooks();
      const view = buildLibraryView(books);
      return { ...base, messageText: view.text, keyboard: view.keyboard };
    }

    if (callbackData === 'svc_orders') {
      const [orders, scholarship] = await Promise.all([
        scraper.getOrders(),
        scraper.getScholarship(),
      ]);
      const view = buildOrdersView(orders, scholarship);
      return { ...base, messageText: view.text, keyboard: view.keyboard };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    // Сессия БАРС истекла — возвращаем пользователя на экран входа
    if (err instanceof SessionExpiredError) {
      resetAuthFlow(sender.id);
      userStore.clearAuth(sender.id);
      const view = buildLoginPromptView(user.firstName, 'Сессия БАРС истекла. Войдите заново.');
      return {
        action: 'edit',
        messageText: view.text,
        keyboard: view.keyboard,
        deleteIncoming: false,
        user: userStore.get(sender.id) ?? user,
        status: 'need_login',
      };
    }

    const serviceName =
      callbackData === 'svc_grades'
        ? 'Оценки'
        : callbackData === 'svc_attendance'
          ? 'Пропуски'
          : callbackData === 'svc_library'
            ? 'Книги'
            : 'Приказы и стипендия';

    const view = buildServiceErrorView(serviceName, msg);
    return { ...base, messageText: view.text, keyboard: view.keyboard };
  }

  const moreView = buildMoreHubView(user);
  return { ...base, messageText: moreView.text, keyboard: moreView.keyboard };
}

export async function processTelegramCallback(
  sender: TelegramSender,
  callbackData: string
): Promise<ProcessMessageResult> {
  const storedUser = userStore.get(sender.id);
  markActive(sender.id);

  // Гейт авторизации: клик без входа в БАРС возвращает на экран логина
  if (!isBarsAuthorized(storedUser)) {
    const guest = userStore.ensureUser(sender.id, {
      firstName: sender.firstName,
      lastName: sender.lastName,
      username: sender.username,
      authState: 'AWAIT_LOGIN',
    });

    const view = buildLoginPromptView(sender.firstName);
    return {
      action: 'edit',
      messageText: view.text,
      keyboard: view.keyboard,
      deleteIncoming: false,
      user: guest,
      status: 'need_login',
    };
  }

  const user: TelegramUser = storedUser;
  const groupName = user.groupName ?? '';

  // 1. Обед
  if (callbackData === 'lunch_joke') {
    const joke = getRandomLunchJoke();
    return {
      action: 'edit',
      messageText: '',
      deleteIncoming: false,
      user,
      status: 'registered',
      toast: joke,
    };
  }

  // 2. Инструкция по ДЗ
  if (callbackData === 'prompt_dz') {
    const promptView = buildAddHwInstructionView();
    return {
      action: 'edit',
      messageText: promptView.text,
      keyboard: promptView.keyboard,
      deleteIncoming: false,
      user,
      status: 'registered',
    };
  }

  // 3. Раздел «Важное»
  if (callbackData === 'nav_important') {
    waitingForImportantText.delete(sender.id);
    const impView = buildImportantListView(groupName);
    return {
      action: 'edit',
      messageText: impView.text,
      keyboard: impView.keyboard,
      deleteIncoming: false,
      user,
      status: 'registered',
    };
  }

  // 4. Просмотр важного сообщения
  if (callbackData.startsWith('imp:')) {
    const id = callbackData.slice(4);
    const detailView = buildImportantDetailView(id);
    return {
      action: 'edit',
      messageText: detailView.text,
      keyboard: detailView.keyboard,
      filesToSend: detailView.filesToSend,
      deleteIncoming: false,
      user,
      status: 'registered',
    };
  }

  // 5. Добавить важное
  if (callbackData === 'imp_add') {
    markWaitingForImportantText(sender.id);
    const addPrompt = buildImportantAddPromptView();
    return {
      action: 'edit',
      messageText: addPrompt.text,
      keyboard: addPrompt.keyboard,
      deleteIncoming: false,
      user,
      status: 'registered',
    };
  }

  // 6. Удаление важного: подтверждение и действие
  if (callbackData.startsWith('imp_del_ask:')) {
    const id = callbackData.slice(12);
    const imp = importantStore.get(id);
    if (!imp) {
      const list = buildImportantListView(groupName);
      return {
        action: 'edit',
        messageText: list.text,
        keyboard: list.keyboard,
        deleteIncoming: false,
        user,
        status: 'registered',
        toast: 'Уже удалено.',
      };
    }
    const confirmView = buildConfirmDeleteView('imp', id, imp.title);
    return {
      action: 'edit',
      messageText: confirmView.text,
      keyboard: confirmView.keyboard,
      deleteIncoming: false,
      user,
      status: 'registered',
    };
  }

  if (callbackData.startsWith('imp_del_confirm:')) {
    const id = callbackData.slice(16);
    const deleted = importantStore.delete(id);
    const list = buildImportantListView(groupName);
    return {
      action: 'edit',
      messageText: list.text,
      keyboard: list.keyboard,
      deleteIncoming: false,
      user,
      status: 'registered',
      toast: 'Объявление удалено',
      deletedChannelMessageIds: deleted?.channelMessageIds,
    };
  }

  // 7. Раздел «ДЗ»
  if (callbackData === 'nav_dz') {
    const hwView = buildHomeworkListView(groupName);
    return {
      action: 'edit',
      messageText: hwView.text,
      keyboard: hwView.keyboard,
      deleteIncoming: false,
      user,
      status: 'registered',
    };
  }

  // 8. Карточка конкретного ДЗ
  if (callbackData.startsWith('hw_detail:')) {
    const id = callbackData.slice(10);
    const hwDetail = buildSingleHomeworkDetailView(id);
    return {
      action: 'edit',
      messageText: hwDetail.text,
      keyboard: hwDetail.keyboard,
      filesToSend: hwDetail.filesToSend,
      deleteIncoming: false,
      user,
      status: 'registered',
    };
  }

  // 9. Удаление ДЗ: запрос подтверждения и действие
  if (callbackData.startsWith('hw_del_ask:')) {
    const id = callbackData.slice(11);
    const hw = homeworkStore.get(id);
    if (!hw) {
      const list = buildHomeworkListView(groupName);
      return {
        action: 'edit',
        messageText: list.text,
        keyboard: list.keyboard,
        deleteIncoming: false,
        user,
        status: 'registered',
        toast: 'ДЗ уже удалено.',
      };
    }
    const displayDate = formatDisplayDate(hw.targetDate);
    const confirmView = buildConfirmDeleteView('hw', id, `${hw.discipline} (${displayDate})`);
    return {
      action: 'edit',
      messageText: confirmView.text,
      keyboard: confirmView.keyboard,
      deleteIncoming: false,
      user,
      status: 'registered',
    };
  }

  if (callbackData.startsWith('hw_del_confirm:')) {
    const id = callbackData.slice(15);
    const deleted = homeworkStore.delete(id);
    const list = buildHomeworkListView(groupName);
    return {
      action: 'edit',
      messageText: list.text,
      keyboard: list.keyboard,
      deleteIncoming: false,
      user,
      status: 'registered',
      toast: 'ДЗ удалено',
      deletedChannelMessageIds: deleted?.channelMessageIds,
    };
  }

  // 10. Экран «⚙️ Остальное»
  if (callbackData === 'nav_more') {
    waitingForImportantText.delete(sender.id);
    const moreView = buildMoreHubView(user);
    return {
      action: 'edit',
      messageText: moreView.text,
      keyboard: moreView.keyboard,
      deleteIncoming: false,
      user,
      status: 'registered',
    };
  }

  // 11. Главное меню расписания
  if (callbackData === 'nav_menu') {
    waitingForImportantText.delete(sender.id);
    clearScheduleCache(user.groupId);

    try {
      const schedule = await getCachedSchedule(user);
      const view = buildMainScheduleView(schedule, undefined, user);
      return {
        action: 'edit',
        messageText: view.text,
        keyboard: view.keyboard,
        deleteIncoming: false,
        user,
        status: 'registered',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        action: 'edit',
        messageText: [
        `⚠️ ${b('Не удалось загрузить расписание')}`,
        '',
        quote(esc(truncate(msg, 240))),
      ].join('\n'),
        keyboard: [
          [toneButton('🔄 Повторить', 'session', 'refresh_schedule')],
          [toneButton('⚙️ Остальное', 'more', 'nav_more')],
        ],
        deleteIncoming: false,
        user,
        status: 'registered',
      };
    }
  }

  // 12. Принудительное обновление расписания (кнопка и /reflash)
  if (callbackData === 'refresh_schedule') {
    waitingForImportantText.delete(sender.id);
    const reflash = await buildReflashView(user);
    return { ...reflash, deleteIncoming: false };
  }

  // 12. Выход из аккаунта БАРС
  if (callbackData === 'auth_logout') {
    resetAuthFlow(sender.id);
    userStore.clearAuth(sender.id);
    const logoutView = buildLogoutView();

    return {
      action: 'edit',
      messageText: logoutView.text,
      keyboard: [],
      deleteIncoming: false,
      user: userStore.get(sender.id) ?? user,
      status: 'need_login',
      toast: 'Вы вышли из аккаунта БАРС',
    };
  }

  // 13. Начать вход заново
  if (callbackData === 'auth_restart') {
    resetAuthFlow(sender.id);
    const view = buildLoginPromptView(user.firstName);
    return {
      action: 'edit',
      messageText: view.text,
      keyboard: view.keyboard,
      deleteIncoming: false,
      user,
      status: 'need_login',
    };
  }

  // 14. Обновление сессии БАРС
  if (callbackData === 'auth_refresh_session') {
    const fresh = userStore.get(sender.id) ?? user;
    const valid = await isBarsSessionValid(fresh);

    if (!valid) {
      resetAuthFlow(sender.id);
      const view = buildLoginPromptView(
        fresh.firstName,
        'Сессия БАРС истекла. Войдите заново.',
      );
      userStore.clearAuth(sender.id);

      return {
        action: 'edit',
        messageText: view.text,
        keyboard: view.keyboard,
        deleteIncoming: false,
        user: userStore.get(sender.id) ?? fresh,
        status: 'need_login',
      };
    }

    // Сессия жива: обновляем метку времени и заново связываем группу с расписанием
    userStore.patch(sender.id, { barsAuthedAt: new Date().toISOString() });

    const restored = userStore.get(sender.id) ?? fresh;
    if (typeof restored.groupId === 'number' && restored.groupId > 0) {
      clearScheduleCache(restored.groupId);
      const schedule = await getCachedSchedule(restored);
      const view = buildMainScheduleView(schedule, undefined, restored);
      return {
        action: 'edit',
        messageText: view.text,
        keyboard: view.keyboard,
        deleteIncoming: false,
        user: restored,
        status: 'registered',
        toast: 'Сессия обновлена',
      };
    }

    const view = buildLoginPromptView(restored.firstName, 'Группа для расписания не определена.');
    return {
      action: 'edit',
      messageText: view.text,
      keyboard: view.keyboard,
      deleteIncoming: false,
      user: restored,
      status: 'need_login',
    };
  }

  // 15. Сервисные разделы БАРС
  if (callbackData.startsWith('svc_')) {
    return await handleServiceCallback(sender, user, callbackData);
  }

  // 11. Подробный просмотр занятия: "sub:<rawDate>:<slotIndex>"
  if (callbackData.startsWith('sub:')) {
    const [, rawDate, slotIndexStr] = callbackData.split(':');
    const slotIndex = parseInt(slotIndexStr, 10);

    const schedule = await getCachedSchedule(user);
    const view = buildSubjectDetailView(schedule, rawDate, slotIndex);

    return {
      action: 'edit',
      messageText: view.text,
      keyboard: view.keyboard,
      filesToSend: view.filesToSend,
      deleteIncoming: false,
      user,
      status: 'registered',
    };
  }

  // 16. Навигация по дням расписания
  waitingForImportantText.delete(sender.id);
  const schedule = await getCachedSchedule(user);
  let targetDate: string | undefined;

  if (callbackData.startsWith('day:')) {
    const param = callbackData.split(':')[1];
    if (param !== 'current') {
      targetDate = param;
    }
  }

  const view = buildMainScheduleView(schedule, targetDate, user);

  return {
    action: 'edit',
    messageText: view.text,
    keyboard: view.keyboard,
    deleteIncoming: false,
    user,
    status: 'registered',
  };
}
