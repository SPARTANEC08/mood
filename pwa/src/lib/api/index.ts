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
  BootstrapResponse,
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
  NotificationsUnreadResponse,
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
   * Включает или выключает уведомления в Telegram.
   *
   * Идемпотентно: сервер запоминает флаг и отвечает тем же, что прислали, —
   * поэтому кнопку можно нажимать дважды подряд без побочных эффектов.
   */
  toggleNotifications: (enabled: boolean) =>
    request<{ ok: true; enabled: boolean; telegramId: number | null }>('/notifications/toggle', {
      method: 'POST',
      body: { enabled },
    }),

  /**
   * Текущее состояние подписки.
   *
   * Отдельный лёгкий маршрут вместо повторного bootstrap: «Кабинет» перечитывает
   * состояние при возврате на вкладку, а bootstrap ходит в БАРС и IMAP.
   */
  notificationsState: () =>
    request<{ telegramId: number | null; notificationsEnabled: boolean }>('/notifications/state'),

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

  /** Только счётчик для бейджа на колокольчике. */
  notificationsUnread: () =>
    request<NotificationsUnreadResponse>('/notifications/unread-count'),

  /** «Прочитать все»: отметить все события и закрыть объявления. */
  readAllNotifications: () =>
    request<{ ok: true; unread: 0 }>('/notifications/read-all', { method: 'POST' }),

  /** «Закрыть»: рассылка скрывается, событие помечается прочитанным. */
  readNotification: (id: string) =>
    request<{ ok: true }>(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
};

export type Api = typeof api;
