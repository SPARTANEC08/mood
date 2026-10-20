/**
 * Экраны админ-меню.
 *
 * Собираются отдельно от клиентских: админка — служебный интерфейс владельца,
 * и смешивать её с пользовательским меню в одном файле значит каждый раз
 * проверять, не показали ли студенту кнопку «Рассылка».
 */

import type { AdminRecord } from '../db/storage/adminsStore.ts';
import { registrationStore } from '../db/storage/registrationStore.ts';
import { b, code, esc, i, joinBlocks, link, RULE } from './format.ts';
import { pageOfReports, type ReportFile } from './reports.ts';
import type { BotViewResult, InlineButton } from './pwaView.ts';

function btn(text: string, data: string, style?: InlineButton['style']): InlineButton {
  return style ? { text, callback_data: data, style } : { text, callback_data: data };
}

function backToAdmin(): InlineButton[] {
  return [btn('🏠 В админку', 'admin')];
}

/**
 * Ссылка на живую страницу статистики с токеном из env.
 *
 * Токен кладётся во ФРАГМЕНТ (`#`), а не в query: именно так его читает сама
 * страница `/dev/` (`getTokenFromHash` → localStorage). С `?key=` она токен не
 * видит и показывает форму ввода — снаружи это выглядело как «ссылка просит
 * токен». Фрагмент к тому же не уходит на сервер и не попадает в access-логи.
 */
export function buildStatsUrl(): string | null {
  const token = process.env.DEV_STATS_TOKEN?.trim();
  if (!token) return null;

  const base = (process.env.PWA_URL?.trim() || 'https://109-120-129-61.sslip.io').replace(/\/+$/, '');
  return `${base}/dev/#${encodeURIComponent(token)}`;
}

/** Главное админ-меню. */
export function buildAdminMenu(): BotViewResult {
  /**
   * Прямая ссылка на страницу статистики с токеном во фрагменте: одно нажатие —
   * и владелец на живой странице, без ввода токена руками.
   *
   * URL-кнопка (не callback): Telegram сам открывает браузер, поэтому ссылка
   * должна лежать прямо в меню. Токен во фрагменте (`#`), а не в query: так его
   * читает сама страница /dev/, и он не попадает ни на сервер, ни в access-логи.
   */
  const statsUrl = buildStatsUrl();
  const registrationOpen = registrationStore.isOpen();

  return {
    text: joinBlocks([
      `🛠 ${b('Администратор')}`,
      i('Служебные действия. Клиентское меню — кнопкой ниже.'),
      i(`Регистрация новых аккаунтов: ${registrationOpen ? 'открыта' : 'закрыта'}.`),
    ]),
    keyboard: [
      ...(statsUrl ? [[{ text: '🌐 Статистика (/dev)', url: statsUrl }]] : []),
      [btn('📊 Отчёт сейчас', 'admin_report_now'), btn('📜 Отчёты', 'admin_reports:0')],
      [btn('🔄 Обновить почту', 'admin_mail'), btn('📣 Рассылка', 'admin_broadcast')],
      [
        btn(
          registrationOpen ? '🔓 Регистрация: вкл' : '🔒 Регистрация: выкл',
          'admin_registration',
          registrationOpen ? 'success' : 'danger',
        ),
      ],
      [btn('👤 Назначить', 'admin_add'), btn('🚫 Снять', 'admin_remove')],
      [btn('🏠 В клиентское меню', 'menu')],
    ],
  };
}

/** Статистика: одна и та же ссылка, без генерации. */
export function buildStatsView(): BotViewResult {
  const url = buildStatsUrl();

  if (!url) {
    return {
      text: joinBlocks([
        `📊 ${b('Статистика')}`,
        '`DEV_STATS_TOKEN` не задан на сервере — ссылка недоступна.',
        '',
        i('Добавь токен в .env и перезапусти сервис.'),
      ]),
      keyboard: [backToAdmin()],
    };
  }

  return {
    text: joinBlocks([
      `📊 ${b('Статистика')}`,
      'Живая страница статистики (доступ по токену):',
      '',
      link(url, '🌐 Открыть /dev/'),
      '',
      i('Ссылка постоянная. Токен не показывается в тексте.'),
    ]),
    keyboard: [
      [{ text: '🌐 Открыть статистику', url }],
      backToAdmin(),
    ],
  };
}

/** Страница со списком отчётов-дат. */
export function buildReportsView(reports: ReportFile[], page: number): BotViewResult {
  if (reports.length === 0) {
    return {
      text: joinBlocks([
        `📜 ${b('Отчёты')}`,
        'Отчётов пока нет.',
        i('Файлы появятся в db/data/reports/ после формирования среза статистики.'),
      ]),
      keyboard: [backToAdmin()],
    };
  }

  const { items, page: safePage, pages } = pageOfReports(reports, page);

  const rows: InlineButton[][] = [];
  for (let index = 0; index < items.length; index += 5) {
    rows.push(items.slice(index, index + 5).map((report) => btn(report.label, `rep:${report.key}`)));
  }

  const nav: InlineButton[] = [];
  if (safePage > 0) nav.push(btn('◀ Новее', `admin_reports:${safePage - 1}`));
  if (safePage < pages - 1) nav.push(btn('Старее ▶', `admin_reports:${safePage + 1}`));
  if (nav.length > 0) rows.push(nav);
  rows.push(backToAdmin());

  return {
    text: joinBlocks([
      `📜 ${b('Отчёты')}`,
      `Страница ${safePage + 1} из ${pages}. Нажми дату — пришлю HTML-файл.`,
    ]),
    keyboard: rows,
  };
}

/** Подтверждение прогона почты для всех. */
export function buildMailRefreshConfirmView(): BotViewResult {
  return {
    text: joinBlocks([
      `🔄 ${b('Обновить почту всем?')}`,
      'Проверю БАРС и почту для всех пользователей. Между людьми пауза 2.5 с — это защита от бана МЭИ, поэтому прогон может занять время.',
    ]),
    keyboard: [
      [btn('✅ Запустить', 'admin_mail_yes', 'success'), btn('✕ Отмена', 'admin')],
      backToAdmin(),
    ],
  };
}

/** Пока идёт длинный прогон. */
export function buildMailRefreshRunningView(): string {
  return `⏳ ${b('Обновляю почту…')}\nЭто может занять несколько минут.`;
}

/** Итог прогона. */
export function buildMailRefreshResultView(result: {
  processed: number;
  notified: number;
  errors: number;
}): BotViewResult {
  return {
    text: joinBlocks([
      `✅ ${b('Обновление завершено')}`,
      `Проверено: ${b(String(result.processed))}`,
      `Уведомлений: ${b(String(result.notified))}`,
      `Ошибок: ${b(String(result.errors))}`,
    ]),
    keyboard: [backToAdmin()],
  };
}

/** Ошибка запуска: уже идёт. */
export function buildMailRefreshBusyView(): BotViewResult {
  return {
    text: joinBlocks([`⏳ ${b('Уже выполняется')}`, 'Дождись окончания текущего прогона.']),
    keyboard: [backToAdmin()],
  };
}

/** Запрос текста рассылки. */
export function buildBroadcastPromptView(): BotViewResult {
  return {
    text: joinBlocks([
      `📣 ${b('Рассылка')}`,
      'Пришли текст одним сообщением. Поддерживается обычный текст (HTML не интерпретируется).',
      i('Максимум 4096 символов.'),
    ]),
    keyboard: [[btn('✕ Отмена', 'admin')]],
  };
}

/** Превью рассылки: ровно то, что увидят пользователи, плюс выбор канала. */
export function buildBroadcastPreviewView(text: string): BotViewResult {
  return {
    text: joinBlocks([
      `👀 ${b('Превью рассылки')}`,
      'Так увидят пользователи:',
      RULE,
      esc(text),
      RULE,
      i('В Telegram — привязанным к боту.'),
      i('В приложение — всем авторизованным в БАРС (очередь уведомлений).'),
    ]),
    keyboard: [
      [btn('📨 В Telegram', 'broadcast_send:tg', 'primary')],
      [btn('📱 В приложение', 'broadcast_send:app', 'primary')],
      [btn('📨📱 Везде', 'broadcast_send:both', 'success')],
      [btn('✕ Отмена', 'admin_broadcast_cancel')],
    ],
  };
}

/** Итог рассылки. */
export function buildBroadcastResultView(
  sent: number,
  failed: number,
  skipped: number,
  appQueued = false,
): BotViewResult {
  return {
    text: joinBlocks([
      `✅ ${b('Рассылка завершена')}`,
      `В Telegram отправлено: ${b(String(sent))}`,
      `Ошибок: ${b(String(failed))}`,
      skipped > 0 ? `Пропущено (нет Telegram): ${b(String(skipped))}` : '',
      appQueued ? `В приложение: ${b('добавлено в очередь')}` : '',
      failed > 0 ? '' : undefined,
      failed > 0
        ? i('Ошибки — это заблокировавшие бота, удалённые аккаунты или очищенные чаты. Подробности в журнале сервиса.')
        : '',
    ]),
    keyboard: [backToAdmin()],
  };
}

/** Запрос Telegram ID для назначения админа. */
export function buildAdminAddPromptView(): BotViewResult {
  return {
    text: joinBlocks([
      `👤 ${b('Назначить админа')}`,
      'Пришли Telegram ID числом. Он получит доступ к админ-меню.',
      i('ID можно узнать в @userinfobot.'),
    ]),
    keyboard: [[btn('✕ Отмена', 'admin')]],
  };
}

/** Подтверждение назначения. */
export function buildAdminAddConfirmView(telegramId: number): BotViewResult {
  return {
    text: joinBlocks([
      `👤 ${b('Назначить админа?')}`,
      `Telegram ID: ${code(String(telegramId))}`,
    ]),
    keyboard: [
      [btn('✅ Назначить', 'admin_add_yes', 'success'), btn('✕ Отмена', 'admin_add_no')],
    ],
  };
}

/** Результат назначения. */
export function buildAdminAddResultView(telegramId: number, added: boolean): BotViewResult {
  return {
    text: joinBlocks([
      added ? `✅ ${b('Админ назначен')}` : `ℹ️ ${b('Уже админ')}`,
      `Telegram ID: ${code(String(telegramId))}`,
    ]),
    keyboard: [[btn('🏠 В админку', 'admin')]],
  };
}

/** Список назначенных админов для снятия. Env-админов здесь нет. */
export function buildAdminRemoveView(records: AdminRecord[]): BotViewResult {
  if (records.length === 0) {
    return {
      text: joinBlocks([
        `🚫 ${b('Снять админа')}`,
        'Назначенных админов нет.',
        i('Админов из ADMIN_TELEGRAM_IDS снять нельзя — это страховка от потери доступа.'),
      ]),
      keyboard: [backToAdmin()],
    };
  }

  const rows = records.map((record) => [
    btn(`${record.telegramId} · ${formatAddedAt(record.addedAt)}`, `admin_rm:${record.telegramId}`),
  ]);
  rows.push(backToAdmin());

  return {
    text: joinBlocks([
      `🚫 ${b('Снять админа')}`,
      'Нажми на запись, чтобы снять доступ.',
      i('Админов из ADMIN_TELEGRAM_IDS снять нельзя.'),
    ]),
    keyboard: rows,
  };
}

/** Результат снятия. */
export function buildAdminRemoveResultView(telegramId: number, removed: boolean): BotViewResult {
  return {
    text: joinBlocks([
      removed ? `✅ ${b('Админ снят')}` : `⚠️ ${b('Снять не удалось')}`,
      `Telegram ID: ${code(String(telegramId))}`,
      removed ? '' : i('Этот ID в ADMIN_TELEGRAM_IDS — снять его из бота нельзя.'),
    ]),
    keyboard: [[btn('🚫 К списку', 'admin_remove')]],
  };
}

function formatAddedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}
