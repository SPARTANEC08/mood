/**
 * Клиент REST API: JSON-эндпоинты приложения и сборка единого объекта `api`.
 *
 * Транспорт и разбор ошибок — в ./http.ts, работа с файлами — в ./files.ts.
 * Здесь остаются только вызовы эндпоинтов, которые выражаются через `request`,
 * и фасад `api`, которым пользуются страницы.
 */

import type {
  ApiImportant,
  AttendanceResponse,
  BarsMoreResponse,
  BarsSnapshotResponse,
  BootstrapProfile,
  BootstrapResponse,
  AuthConfigResponse,
  LegalStatus,
  LegalDocId,
  LegalDocumentMeta,
  CreateHomeworkBody,
  CreateImportantBody,
  GradesResponse,
  MailResponse,
  ScheduleResponse,
  SubjectsResponse,
  ApiHomework,
  ServerFileRef,
  UpdateHomeworkBody,
  UpdateImportantBody,
  NextAnnouncementResponse,
  NextNotificationResponse,
  NotificationsFeedResponse,
  GuestGroupsResponse,
  AdminStatsPeriod,
  AdminStatsResponse,
  AdminUserSummary,
  AdminUserDetails,
  AdminUserFilter,
  AdminJob,
  AdminAnnouncement,
  AdminDiagnostics,
  AdminAdminsResponse,
  AdminAuditEntry,
  AdminThemesResponse,
  ApiTheme,
  CreateThemeBody,
  ThemesResponse,
} from '@/types/api';
import {
  deleteFile,
  createFileShareLink,
  downloadFile,
  fetchFile,
  openFileInSystemViewer,
  prefetchFile,
  previewUrl,
  uploadFile,
} from './files.ts';
import { request } from './http.ts';

export const api = {
  // ── файлы (реализация в ./files.ts) ──────────────────────────────────────
  previewUrl,
  createFileShareLink,
  fetchFile,
  prefetchFile,
  downloadFile,
  openFileInSystemViewer,
  uploadFile,
  deleteFile,

  // ── профиль и расписание ─────────────────────────────────────────────────
  bootstrap: () => request<BootstrapResponse>('/bootstrap'),

  // ── юридические документы и согласия ─────────────────────────────────────
  legalDocuments: () =>
    request<{
      documents: LegalDocumentMeta[];
      policy: LegalStatus['policy'];
      required: LegalDocId[];
    }>('/legal/documents'),

  legalStatus: () => request<LegalStatus>('/legal/status'),

  acceptConsents: (types: LegalDocId[]) =>
    request<LegalStatus>('/consents', { method: 'POST', body: { types } }),

  /** Публичная конфигурация входа: TTL токена и рубильник регистрации. */
  authConfig: () => request<AuthConfigResponse>('/auth/config'),

  // ── гостевой режим ───────────────────────────────────────────────────────
  /** Подсказки групп из МЭИ; до создания гостя токена ещё нет. */
  guestGroups: (query: string) =>
    request<GuestGroupsResponse>(`/guest/groups?query=${encodeURIComponent(query)}`),

  /** Создать гостевую сессию и получить обычный PWA-токен. */
  guestSession: (body: {
    groupId: number;
    groupName: string;
    faculty?: string;
    displayName: string;
    consents: LegalDocId[];
  }) =>
    request<{ token: string; expiresAt: number; userId: string; profile: BootstrapProfile }>(
      '/guest/session',
      { method: 'POST', body },
    ),

  /** Сменить имя/группу гостя. */
  guestUpdateProfile: (body: {
    displayName?: string;
    groupId?: number;
    groupName?: string;
    faculty?: string;
  }) =>
    request<{ profile: BootstrapProfile }>('/guest/profile', { method: 'PATCH', body }),

  /** Выйти из гостевого режима: сервер удаляет запись гостя целиком. */
  guestExit: () => request<{ ok: true }>('/guest/exit', { method: 'POST' }),

  /** Полное удаление аккаунта. Подтверждение проверяет и сервер. */
  deleteAccount: () =>
    request<{ ok: true }>('/account/delete', {
      method: 'POST',
      body: { confirmation: 'УДАЛИТЬ' },
    }),

  schedule: (params?: { startDate?: string; endDate?: string; force?: boolean }) => {
    const query = new URLSearchParams();
    if (params?.startDate) query.set('startDate', params.startDate);
    if (params?.endDate) query.set('endDate', params.endDate);
    if (params?.force) query.set('force', '1');

    const suffix = query.toString();
    // Расписание разрешено держать открытым дольше: ответ крупный.
    return request<ScheduleResponse>(`/schedule${suffix ? `?${suffix}` : ''}`, { timeoutMs: 30000 });
  },

  // ── БАРС ─────────────────────────────────────────────────────────────────
  grades: () => request<GradesResponse>('/bars/grades', { timeoutMs: 45000 }),
  attendance: () => request<AttendanceResponse>('/bars/attendance', { timeoutMs: 45000 }),
  barsMore: () => request<BarsMoreResponse>('/bars/more', { timeoutMs: 45000 }),
  mail: () => request<MailResponse>('/mail', { timeoutMs: 60000 }),

  /**
   * Принудительное обновление данных БАРС мимо кэша.
   *
   * `refreshBars` в DataProvider — единственный потребитель: без force сервер
   * отдал бы снимок двадцатиминутной давности. Из интерфейса сейчас не
   * вызывается (кнопка «Обновить» убрана), оставлено для программных вызовов.
   */
  barsRefresh: () =>
    request<BarsSnapshotResponse>('/bars/refresh', { method: 'POST', timeoutMs: 45000 }),

  // ── записи ───────────────────────────────────────────────────────────────
  /**
   * ДЗ группы.
   *
   * `from` — с какого дня брать записи («YYYY.MM.DD»). Сервер по умолчанию
   * отдаёт только «сегодня и дальше», а расписанию нужны и прошедшие дни его
   * окна (−14…+90): задания из расписания приходят за весь диапазон, и у каждого
   * должна быть полная запись с вложениями (см. HOMEWORK_LOOKBACK_DAYS в tier1).
   */
  homework: (params?: { from?: string }) => {
    const query = params?.from ? `?from=${encodeURIComponent(params.from)}` : '';
    return request<{ items: ApiHomework[] }>(`/homework${query}`);
  },

  createHomework: (body: CreateHomeworkBody) =>
    request<{
      id: string;
      targetDate: string;
      lessonNumber?: number;
      discipline: string;
      files?: ServerFileRef[];
    }>('/homework', { method: 'POST', body }),

  /** Правка ДЗ своей группы: текст и полный новый состав файлов. */
  updateHomework: (id: string, body: UpdateHomeworkBody) =>
    request<{ id: string; text: string; files: ServerFileRef[] }>(
      `/homework/${encodeURIComponent(id)}`,
      { method: 'PATCH', body },
    ),

  /** Личная отметка «Сделано»: POST — поставить, DELETE — снять. */
  setHomeworkDone: (id: string, done: boolean) =>
    request<{ id: string; done: boolean }>(`/homework/${encodeURIComponent(id)}/done`, {
      method: done ? 'POST' : 'DELETE',
    }),

  important: () => request<{ items: ApiImportant[] }>('/important'),

  /** Все предметы из расписания — источник для выбора в форме ДЗ. */
  subjects: () => request<SubjectsResponse>('/subjects'),

  /** Удаление ДЗ своей группы (файлы удаляются вместе с записью). */
  deleteHomework: (id: string) =>
    request<{ id: string; deleted: boolean }>(`/homework/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  /** Изменение заголовка, текста и состава файлов объявления своей группы. */
  updateImportant: (id: string, body: Partial<UpdateImportantBody>) =>
    request<{ id: string; title: string; text: string; files: ServerFileRef[] }>(
      `/important/${encodeURIComponent(id)}`,
      { method: 'PATCH', body },
    ),

  /** Удаление объявления своей группы (файлы удаляются вместе с записью). */
  deleteImportant: (id: string) =>
    request<{ id: string; deleted: boolean }>(`/important/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  createImportant: (body: CreateImportantBody) =>
    request<{ id: string; title: string; createdAt: string }>('/important', {
      method: 'POST',
      body,
    }),

  // ── уведомления ──────────────────────────────────────────────────────────
  /**
   * Включает или выключает канал уведомлений.
   *
   * Идемпотентно: сервер запоминает флаг и отвечает тем же, что прислали, —
   * поэтому кнопку можно нажимать дважды подряд без побочных эффектов.
   * Канал по умолчанию — Telegram (старый контракт).
   */
  toggleNotifications: (enabled: boolean) =>
    request<{ ok: true; enabled: boolean; pushEnabled: boolean; pushDevices: number }>(
      '/notifications/toggle',
      {
        method: 'POST',
        body: { enabled },
      },
    ),

  /**
   * Текущее состояние подписок.
   *
   * Отдельный лёгкий маршрут вместо повторного bootstrap: «Кабинет» перечитывает
   * состояние при возврате на вкладку, а bootstrap ходит в БАРС и IMAP.
   */
  notificationsState: () =>
    request<{ pushEnabled: boolean; pushDevices: number }>('/notifications/state'),

  // ── Web Push ─────────────────────────────────────────────────────────────
  /** Публичный VAPID-ключ. Пустая строка — канал на сервере не настроен. */
  pushKey: () => request<{ publicKey: string }>('/push/key'),

  /** Сохранить подписку устройства (идемпотентно по endpoint). */
  pushSubscribe: (subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }) =>
    request<{ ok: true; devices: number }>('/push/subscribe', {
      method: 'POST',
      body: subscription,
    }),

  /** Удалить подписку устройства. */
  pushUnsubscribe: (endpoint: string) =>
    request<{ ok: true; devices: number }>('/push/unsubscribe', {
      method: 'POST',
      body: { endpoint },
    }),

  /** Состояние push-канала: флаг и число устройств. */
  pushState: () => request<{ pushEnabled: boolean; devices: number }>('/push/state'),

  // ── объявления внутри приложения ─────────────────────────────────────────
  /** Следующее непрочитанное объявление (очередь админа) или null. */
  announcementNext: () => request<NextAnnouncementResponse>('/announcements/next'),

  /** «Закрыть»: объявление больше не показывается этому пользователю. */
  dismissAnnouncement: (id: string) =>
    request<{ ok: true }>(`/announcements/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }),

  // ── уведомления в приложении (рассылки + события) ────────────────────────
  /** Следующее уведомление: сначала рассылка, затем событие с деталями. */
  notificationNext: () => request<NextNotificationResponse>('/notifications/next'),

  /** Вся лента: объявления и события, новые сверху. */
  notificationsFeed: () => request<NotificationsFeedResponse>('/notifications'),

  /** «Закрыть»: рассылка скрывается, событие помечается прочитанным. */
  readNotification: (id: string) =>
    request<{ ok: true }>(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),

  // ── темы оформления ─────────────────────────────────────────────────────
  /** Темы сообщества. Официальные живут в коде и в этот запрос не входят. */
  themes: () => request<ThemesResponse>('/themes'),

  /** Опубликовать свою тему. Сервер сам ставит автора и id. */
  createTheme: (body: CreateThemeBody) =>
    request<{ theme: ApiTheme }>('/themes', { method: 'POST', body }),

  /** Удалить свою тему. Чужую сервер не даст удалить. */
  deleteTheme: (id: string) =>
    request<{ ok: true }>(`/themes/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── админка ──────────────────────────────────────────────────────────────
  adminStats: (params: { period: AdminStatsPeriod; date?: string }) => {
    const query = new URLSearchParams({ period: params.period });
    if (params.date) query.set('date', params.date);
    return request<AdminStatsResponse>(`/admin/stats?${query.toString()}`);
  },

  adminUsers: (query: string, limit = 50, filter: AdminUserFilter = 'all') =>
    request<{ users: AdminUserSummary[]; total: number }>(
      `/admin/users?query=${encodeURIComponent(query)}&limit=${limit}&filter=${filter}`,
    ),

  adminUser: (id: string) =>
    request<AdminUserDetails>(`/admin/users/${encodeURIComponent(id)}`),

  adminResetSessions: (id: string) =>
    request<{ ok: true }>(`/admin/users/${encodeURIComponent(id)}/reset-sessions`, {
      method: 'POST',
    }),

  adminDeleteUser: (id: string, confirmation: string) =>
    request<{ ok: true }>(`/admin/users/${encodeURIComponent(id)}/delete`, {
      method: 'POST',
      body: { confirmation },
    }),

  adminSendMessage: (body: {
    text: string;
    url?: string;
    userId?: string;
    channels: { feed: boolean; push: boolean };
  }) => request<{ jobId: string; total: number }>('/admin/messages', { method: 'POST', body }),

  adminBroadcast: (body: { text: string; url?: string; userId?: string }) =>
    request<{ jobId: string; total: number }>('/admin/broadcast', { method: 'POST', body }),

  adminRunNotifier: () =>
    request<{ jobId: string; total: number }>('/admin/notifier/run', { method: 'POST' }),

  adminJob: (id: string) => request<AdminJob>(`/admin/jobs/${encodeURIComponent(id)}`),

  adminAnnouncements: () =>
    request<{ items: AdminAnnouncement[] }>('/admin/announcements'),

  adminCreateAnnouncement: (body: { text: string; userId?: string }) =>
    request<{ item: AdminAnnouncement }>('/admin/announcements', { method: 'POST', body }),

  adminDeleteAnnouncement: (id: string) =>
    request<{ ok: true }>(`/admin/announcements/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  adminDiagnostics: () => request<AdminDiagnostics>('/admin/diagnostics'),

  adminThemes: (status: 'all' | 'published' | 'hidden' = 'all') =>
    request<AdminThemesResponse>(`/admin/themes?status=${status}`),

  adminHideTheme: (id: string) =>
    request<{ ok: true }>(`/admin/themes/${encodeURIComponent(id)}/hide`, { method: 'POST' }),

  adminUnhideTheme: (id: string) =>
    request<{ ok: true }>(`/admin/themes/${encodeURIComponent(id)}/unhide`, { method: 'POST' }),

  adminDeleteTheme: (id: string) =>
    request<{ ok: true }>(`/admin/themes/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  adminMaintenance: () =>
    request<{ result: Record<string, number | null> }>('/admin/maintenance', { method: 'POST' }),

  adminRegistration: () => request<{ open: boolean }>('/admin/registration'),

  adminSetRegistration: (open: boolean) =>
    request<{ open: boolean }>('/admin/registration', { method: 'POST', body: { open } }),

  adminAdmins: () => request<AdminAdminsResponse>('/admin/admins'),

  adminAddAdmin: (userId: string) =>
    request<{ ok: true }>('/admin/admins', { method: 'POST', body: { userId } }),

  adminRemoveAdmin: (userId: string) =>
    request<{ ok: true }>(`/admin/admins/${encodeURIComponent(userId)}`, { method: 'DELETE' }),

  adminAudit: (limit = 50) =>
    request<{ items: AdminAuditEntry[] }>(`/admin/audit?limit=${limit}`),
};

export type Api = typeof api;
