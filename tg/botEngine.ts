/**
 * Маршрутизация бота: сообщения, кнопки, FSM админских действий.
 *
 * Один экран на каждое состояние, редактирование текущего сообщения — в
 * telegramService. Здесь только решение «что показать» и побочные эффекты
 * (привязка, отвязка, права, рассылка), без grammY: так сценарии можно
 * проверять без сети.
 *
 * Ключевые правила:
 *  - `/start` без userId не создаёт запись и не привязывает ничего;
 *  - `/start <userId>` не перепривязывает Telegram, если он уже занят другой
 *    записью (или целевая запись занята другим Telegram) — защита от угона;
 *  - админ-кнопки проверяются на каждом callback, а не только при отрисовке.
 */

import {
  addAdmin,
  isAdmin,
  listAssignedAdmins,
  removeAdmin,
} from '../db/storage/adminsStore.ts';
import { userStore, type StoredUser } from '../db/storage/userStore.ts';
import { announcementStore } from '../db/storage/announcementStore.ts';
import { isNotifierCycleRunning, runCycleForced } from '../backend/services/notifications/barsNotifier.ts';
import {
  buildAdminAddConfirmView,
  buildAdminAddPromptView,
  buildAdminAddResultView,
  buildAdminMenu,
  buildAdminRemoveResultView,
  buildAdminRemoveView,
  buildBroadcastPromptView,
  buildBroadcastPreviewView,
  buildBroadcastResultView,
  buildMailRefreshBusyView,
  buildMailRefreshConfirmView,
  buildMailRefreshResultView,
  buildReportsView,
  buildStatsView,
} from './adminView.ts';
import { clearFlow, getFlow, setFlow, setFlowData, takeExpiredNotice } from './botState.ts';
import { broadcastText, validateBroadcastText, type BroadcastSend } from './broadcast.ts';
import { esc, safeErrorMessage } from './format.ts';
import {
  buildAccountNotFoundView,
  buildAndroidGuideView,
  buildClientMenu,
  buildIosGuideView,
  buildTargetLinkedElsewhereView,
  buildTgLinkedElsewhereView,
  buildUnlinkedView,
  buildUnlinkConfirmView,
  buildWelcomeView,
  type BotViewResult,
} from './pwaView.ts';
import { findReport, listReports } from './reports.ts';
import { getStats } from '../backend/server/devStats.ts';
import { renderReportHtml } from '../backend/services/notifications/reportHtml.ts';

/** От кого пришло сообщение/нажатие. */
export interface TelegramSender {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
}

/** Что показать и какие действия выполнить в telegramService. */
export interface ProcessResult {
  view: BotViewResult;
  toast?: string;
  /** Удалить сообщение, на кнопке которого нажали (уведомления, «Закрыть»). */
  deleteCurrent?: boolean;
  /** Не редактировать текущее, а отправить новое (например, после удаления). */
  forceNewMessage?: boolean;
}

/** Прогресс прогона почты: сколько проверено из скольких. */
export type MailProgress = (processed: number, total: number) => void | Promise<void>;

/** Внешние зависимости: подменяются в тестах. */
export interface BotEngineDeps {
  broadcast?: BroadcastSend;
  runMailRefresh?: (onProgress?: MailProgress) => Promise<{ processed: number; notified: number; errors: number } | null>;
  /** Куда сообщать прогресс прогона почты (правит сообщение в чате). */
  onMailProgress?: MailProgress;
}

const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Аргумент `/start` (UUID) или null. */
export function parseStartArgument(text: string): string | null {
  const match = /^\/start(?:@\w+)?\s*(\S+)?/.exec(text.trim());
  const arg = match?.[1]?.trim();
  if (!arg || !USER_ID_RE.test(arg)) return null;
  return arg.toLowerCase();
}

/** Решение о привязке. Вынесено отдельно, чтобы покрыть тестами. */
export type LinkDecision =
  | 'link'
  | 'not_found'
  | 'tg_linked_elsewhere'
  | 'target_linked_elsewhere';

export function decideLink(
  telegramId: number,
  target: StoredUser | undefined,
  current: StoredUser | undefined,
): LinkDecision {
  if (!target) return 'not_found';
  if (current && current.userId !== target.userId) return 'tg_linked_elsewhere';
  if (typeof target.telegramId === 'number' && target.telegramId !== telegramId) {
    return 'target_linked_elsewhere';
  }
  return 'link';
}

function linkTelegram(telegramId: number, userId: string): void {
  userStore.patchByUserId(userId, { telegramId, notificationsEnabled: true });
}

/** Клиентское меню или приветствие, если привязки нет. */
function menuFor(telegramId: number): BotViewResult {
  const user = userStore.findUserByTelegramId(telegramId);
  return user ? buildClientMenu(user, isAdmin(telegramId)) : buildWelcomeView();
}

/** Проверка админа на каждом админском callback. */
function adminGuard(telegramId: number): ProcessResult | null {
  if (isAdmin(telegramId)) return null;
  return {
    view: menuFor(telegramId),
    toast: 'Недостаточно прав',
  };
}

function adminMenuResult(): ProcessResult {
  return { view: buildAdminMenu() };
}

/** Входящее сообщение. */
export async function processTelegramMessage(
  sender: TelegramSender,
  text: string,
  deps: BotEngineDeps = {},
): Promise<ProcessResult> {
  const trimmed = (text ?? '').trim();

  // FSM проверяем раньше команд: админ в режиме «жду текст» присылает обычный
  // текст, и он не должен уходить в меню.
  if (isAdmin(sender.id)) {
    const flow = getFlow(sender.id);

    if (flow?.kind === 'broadcast_text') {
      const error = validateBroadcastText(trimmed);
      if (error) {
        const prompt = buildBroadcastPromptView();
        return { view: { ...prompt, text: `⚠️ ${esc(error)}\n\n${prompt.text}` } };
      }
      setFlowData(sender.id, trimmed);
      return { view: buildBroadcastPreviewView(trimmed) };
    }

    if (flow?.kind === 'admin_add_id') {
      const value = Number(trimmed);
      if (!Number.isInteger(value) || value <= 0) {
        const prompt = buildAdminAddPromptView();
        return { view: { ...prompt, text: `⚠️ Нужен числовой Telegram ID.\n\n${prompt.text}` } };
      }
      setFlowData(sender.id, String(value));
      return { view: buildAdminAddConfirmView(value) };
    }

    // Состояния нет, но недавно протухло (в т.ч. после рестарта) — честно
    // говорим, что ожидание сброшено, и заново показываем нужный экран.
    const expired = takeExpiredNotice(sender.id);
    if (expired === 'broadcast_text') {
      const prompt = buildBroadcastPromptView();
      return { view: { ...prompt, text: `⚠️ Сессия истекла, начни заново.\n\n${prompt.text}` } };
    }
    if (expired === 'admin_add_id') {
      const prompt = buildAdminAddPromptView();
      return { view: { ...prompt, text: `⚠️ Сессия истекла, начни заново.\n\n${prompt.text}` } };
    }
  }

  const startArg = parseStartArgument(trimmed);

  if (startArg) {
    const target = userStore.getByUserId(startArg);
    const current = userStore.findUserByTelegramId(sender.id);
    const decision = decideLink(sender.id, target, current);

    if (decision === 'not_found') return { view: buildAccountNotFoundView() };
    if (decision === 'tg_linked_elsewhere') return { view: buildTgLinkedElsewhereView() };
    if (decision === 'target_linked_elsewhere') return { view: buildTargetLinkedElsewhereView() };

    linkTelegram(sender.id, startArg);
    clearFlow(sender.id);
    const linked = userStore.getByUserId(startArg);
    return { view: linked ? buildClientMenu(linked, isAdmin(sender.id)) : buildWelcomeView() };
  }

  // `/start` без адреса, `/app` и любой другой текст: привязанному — меню,
  // остальным — приветствие. Запись в базе не создаётся.
  void deps;
  return { view: menuFor(sender.id) };
}

/** Нажатие кнопки. */
export async function processTelegramCallback(
  sender: TelegramSender,
  callbackData: string,
  deps: BotEngineDeps = {},
): Promise<ProcessResult> {
  const data = (callbackData ?? '').trim();
  const user = userStore.findUserByTelegramId(sender.id);

  // Уборка сообщений: уведомление, «Закрыть», разрушающая кнопка. Ничего не
  // показываем — telegramService просто удалит сообщение.
  if (data === 'notif_dismiss' || data === 'msg_close') {
    return { view: { text: '', keyboard: [] }, deleteCurrent: true };
  }

  // Из уведомления в главное меню: удаляем пуш и отправляем меню новым
  // сообщением (редактировать удалённое нельзя).
  if (data === 'notif_menu') {
    if (!user) {
      return { view: buildWelcomeView(), deleteCurrent: true, forceNewMessage: true };
    }
    return {
      view: buildClientMenu(user, isAdmin(sender.id)),
      deleteCurrent: true,
      forceNewMessage: true,
    };
  }

  if (data === 'menu' || data === 'menu_back') {
    return { view: menuFor(sender.id) };
  }

  if (data === 'notif_on' || data === 'notif_off') {
    if (!user) return { view: buildAccountNotFoundView(), toast: 'Аккаунт не найден' };

    const enabled = data === 'notif_on';
    userStore.patchByUserId(user.userId, { notificationsEnabled: enabled });
    const fresh = userStore.getByUserId(user.userId) ?? user;

    return {
      view: buildClientMenu(fresh, isAdmin(sender.id)),
      toast: enabled ? 'Уведомления включены' : 'Уведомления выключены',
    };
  }

  if (data === 'unlink') {
    if (!user) return { view: buildAccountNotFoundView(), toast: 'Аккаунт не найден' };
    return { view: buildUnlinkConfirmView() };
  }

  if (data === 'unlink_yes') {
    if (!user) return { view: buildAccountNotFoundView(), toast: 'Аккаунт не найден' };
    userStore.patchByUserId(user.userId, {
      telegramId: null,
      notificationsEnabled: false,
    });
    clearFlow(sender.id);
    return { view: buildUnlinkedView(), toast: 'Аккаунт отвязан' };
  }

  if (data === 'platform_ios') return { view: buildIosGuideView() };
  if (data === 'platform_android') return { view: buildAndroidGuideView() };

  // ── Админ-меню ────────────────────────────────────────────────────────────
  const denied = adminGuard(sender.id);
  if (denied) return denied;

  if (data === 'admin') return adminMenuResult();

  if (data === 'admin_stats') return { view: buildStatsView() };

  // «Отчёт сейчас»: срез за последние 24 часа прямо в чат. В БД не сохраняется —
  // архивом владеет только автоотчёт в 00:00 (см. dailyReport.ts).
  if (data === 'admin_report_now') {
    const stats = getStats();
    return {
      view: {
        text: '📊 Отчёт за последние 24 часа',
        keyboard: [[{ text: '🏠 В админку', callback_data: 'admin' }]],
        document: { filename: `stats-${stats.moscowNow.date}.html`, html: renderReportHtml(stats) },
      },
    };
  }

  if (data.startsWith('admin_reports:')) {
    const page = Number.parseInt(data.slice('admin_reports:'.length), 10);
    return { view: buildReportsView(listReports(), Number.isFinite(page) ? page : 0) };
  }

  if (data.startsWith('rep:')) {
    const key = data.slice('rep:'.length);
    const report = findReport(listReports(), key);
    if (!report) {
      return { view: buildReportsView(listReports(), 0), toast: 'Отчёт не найден' };
    }
    return {
      view: {
        text: `📜 Отчёт за ${report.label}`,
        keyboard: [[{ text: '🏠 В админку', callback_data: 'admin' }]],
        document: { path: report.filePath, filename: report.filename },
      },
    };
  }

  if (data === 'admin_mail') return { view: buildMailRefreshConfirmView() };

  if (data === 'admin_mail_yes') {
    const run = deps.runMailRefresh ?? runCycleForced;
    if (isNotifierCycleRunning()) return { view: buildMailRefreshBusyView() };

    const result = await run(deps.onMailProgress);
    if (!result) return { view: buildMailRefreshBusyView() };
    return { view: buildMailRefreshResultView(result) };
  }

  if (data === 'admin_broadcast') {
    setFlow(sender.id, 'broadcast_text');
    return { view: buildBroadcastPromptView() };
  }

  if (data === 'admin_broadcast_cancel') {
    clearFlow(sender.id);
    return adminMenuResult();
  }

  if (data.startsWith('broadcast_send')) {
    const target = data.split(':')[1] ?? '';
    const flow = getFlow(sender.id);
    if (flow?.kind !== 'broadcast_text' || !flow.data) {
      return { view: buildAdminMenu(), toast: 'Черновик рассылки потерян — начни заново' };
    }
    if (!['tg', 'app', 'both'].includes(target)) {
      return { view: buildAdminMenu(), toast: 'Неизвестный канал рассылки' };
    }
    if (target !== 'app' && !deps.broadcast) {
      return { view: buildAdminMenu(), toast: 'Рассылка в Telegram недоступна' };
    }
    if (target !== 'app' && isNotifierCycleRunning()) {
      return { view: buildAdminMenu(), toast: 'Сейчас идёт обновление — попробуй позже' };
    }

    const text = flow.data;
    clearFlow(sender.id);

    // Приложение: объявление становится в очередь и всплывёт у авторизованных.
    const appQueued = target === 'app' || target === 'both';
    if (appQueued) announcementStore.create(text, sender.id);

    // Telegram: только привязанным, с паузами от бана.
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    if (target !== 'app' && deps.broadcast) {
      const result = await broadcastText(text, userStore.all(), deps.broadcast, {
        onError: (telegramId, error) => {
          // Адресат и причина — иначе «Ошибок: M» не отвечает на вопрос «кому и почему».
          console.warn(`[Broadcast] не доставлено ${telegramId}: ${safeErrorMessage(error)}`);
        },
      });
      sent = result.sent;
      failed = result.failed;
      skipped = result.skipped;
    }

    return { view: buildBroadcastResultView(sent, failed, skipped, appQueued) };
  }

  if (data === 'admin_add') {
    setFlow(sender.id, 'admin_add_id');
    return { view: buildAdminAddPromptView() };
  }

  if (data === 'admin_add_no') {
    clearFlow(sender.id);
    return adminMenuResult();
  }

  if (data === 'admin_add_yes') {
    const flow = getFlow(sender.id);
    const value = Number(flow?.data);
    if (!Number.isInteger(value) || value <= 0) {
      clearFlow(sender.id);
      return { view: buildAdminMenu(), toast: 'ID потерян — начни заново' };
    }
    const added = addAdmin(value, sender.id);
    clearFlow(sender.id);
    return { view: buildAdminAddResultView(value, added) };
  }

  if (data === 'admin_remove') {
    return { view: buildAdminRemoveView(listAssignedAdmins()) };
  }

  if (data.startsWith('admin_rm:')) {
    const value = Number.parseInt(data.slice('admin_rm:'.length), 10);
    const removed = Number.isFinite(value) ? removeAdmin(value) : false;
    return { view: buildAdminRemoveResultView(value, removed) };
  }

  // Неизвестное нажатие: показываем меню, а не молчим.
  return { view: menuFor(sender.id) };
}
