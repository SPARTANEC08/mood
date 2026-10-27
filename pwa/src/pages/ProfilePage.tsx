import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  GitBranch,
  GraduationCap,
  Mail,
  MessageCircle,
  ScrollText,
  Send,
  Settings,
} from 'lucide-react';

import { Header } from '@/components/TabBar';
import { Page } from '@/components/Page';
import { Card, SkeletonCard, Toast } from '@/components/ui';
import { RefreshIndicator } from '@/components/RefreshIndicator';
import { usePullToRefresh } from '@/components/PullToRefresh';
import { DeleteAccountCard } from '@/components/profile/DeleteAccountCard';
import { HiddenMenuScreen } from '@/components/profile/HiddenMenuScreen';
import { PushPrompt } from '@/components/profile/PushPrompt';
import { SettingsCard } from '@/components/profile/SettingsCard';
import { StudyLine, StudySection } from '@/components/profile/StudySection';
import { useAppData } from '@/lib/dataContext';
import { plural } from '@/lib/dates';
import { haptic, openLink } from '@/lib/env';
import { logout } from '@/auth';
import { AdminScreen, type AdminSection } from './admin/AdminScreen';
import type { BootstrapResponse } from '@/types/api';

/**
 * Скрытый экран кабинета.
 *
 * Десять тапов по карточке профиля открывают его; пауза дольше указанной
 * обнуляет счётчик, чтобы случайные нажатия не накапливались между заходами.
 */
const HIDDEN_TAPS = 10;
const HIDDEN_TAP_PAUSE_MS = 1200;

/**
 * «Кабинет» по финальному макету.
 *
 * Порядок блоков выбран по частоте использования:
 *  1. кто я;
 *  2. почта — единственное, что хочется открыть сразу;
 *  3. учёба: стипендии, приказы, библиотека — свёрнуты, пока не нужны;
 *  4. настройки приложения;
 *  5. контакты и код;
 *  6. тихий подвал с выходом и удалением аккаунта.
 */
export function ProfilePage({ profile }: { profile: BootstrapResponse }) {
  // Почта и остальные разделы приходят из общего кэша: переключение вкладок
  // не должно снова ходить ни в IMAP, ни в БАРС. Грузятся они лениво — при
  // первом открытии этой вкладки, поэтому скелетоны здесь свои.
  const {
    mail,
    mailError,
    barsMore: more,
    barsError: moreError,
    barsRefreshing,
    refreshBars,
    refreshMail,
  } = useAppData();

  const [toast, setToast] = useState<string | null>(null);

  /**
   * Скрытый экран: десять быстрых тапов по карточке профиля.
   *
   * Пауза длиннее HIDDEN_TAP_PAUSE_MS обнуляет счётчик: случайные нажатия в
   * течение дня не должны однажды «донабрать» десятку. Счётчик живёт в ref,
   * потому что он не влияет на разметку — перерисовка на каждый тап не нужна.
   */
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const hiddenTaps = useRef({ count: 0, at: 0 });

  const handleProfileTap = useCallback(() => {
    const now = Date.now();
    const state = hiddenTaps.current;
    state.count = now - state.at <= HIDDEN_TAP_PAUSE_MS ? state.count + 1 : 1;
    state.at = now;

    if (state.count < HIDDEN_TAPS) return;
    state.count = 0;
    setHiddenOpen(true);
  }, []);

  /**
   * Обновление по жесту.
   *
   * БАРС и почта — параллельно и оба с force-семантикой: на «Кабинете» видно и
   * снимок БАРС (стипендия, приказы, книги), и список писем, поэтому обновлять
   * только половину экрана было бы обманом. Сообщение — первое, что не null.
   */
  const pullRefresh = useCallback(async () => {
    const [barsMessage, mailMessage] = await Promise.all([refreshBars(), refreshMail()]);
    const message = barsMessage ?? mailMessage;
    if (message) setToast(message);
  }, [refreshBars, refreshMail]);

  const pull = usePullToRefresh({ enabled: true, onRefresh: pullRefresh });

  // Блоки рендерятся сразу; тяжёлые данные дозаполняются. Пока данных нет и
  // ошибки тоже нет — показываем скелет соответствующего блока, а не ложное
  // «писем нет»/«стипендия не назначена» на первом кадре захода на вкладку.
  const mailPending = !mail && !mailError;
  const unseen = typeof mail?.unseen === 'number' ? mail.unseen : 0;
  const morePending = !more && !moreError;

  const { profile: p } = profile;

  /*
   * Админка: шестерёнка в шапке и deep link из бота `?admin=stats`.
   *
   * Ссылка открывает нужный раздел один раз и сразу убирает параметр, чтобы
   * перезагрузка не возвращала туда же. Обычному пользователю параметр ничего
   * не открывает — сервер всё равно проверит права.
   */
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminSection, setAdminSection] = useState<AdminSection>('menu');

  useEffect(() => {
    if (!p.isAdmin) return;

    const params = new URLSearchParams(window.location.search);
    if (params.get('admin') !== 'stats') return;

    setAdminSection('stats');
    setAdminOpen(true);

    params.delete('admin');
    const search = params.toString();
    window.history.replaceState(
      null,
      '',
      window.location.pathname + (search ? `?${search}` : '') + window.location.hash,
    );
  }, [p.isAdmin]);

  const initials = p.fullName
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  const scholarships = more?.scholarship.items?.length
    ? more.scholarship.items
    : more?.scholarship.isAppointed
      ? [
          {
            type: more.scholarship.type ?? 'Стипендия',
            period: more.scholarship.period,
            amount: more.scholarship.amount,
            isActive: true,
          },
        ]
      : [];

  const orders = more?.orders ?? [];
  const books = more?.libraryBooks ?? [];
  const overdue = books.filter((book) => book.isOverdue).length;

  const scholarshipSubtitle =
    scholarships.length > 0
      ? `${scholarships.length} ${plural(scholarships.length, 'назначение', 'назначения', 'назначений')}`
      : 'Стипендия не назначена';

  const ordersSubtitle =
    orders.length > 0
      ? `${orders.length} ${plural(orders.length, 'запись', 'записи', 'записей')}`
      : 'Приказов нет';

  const librarySubtitle =
    books.length > 0
      ? `${books.length} ${plural(books.length, 'книга', 'книги', 'книг')}${overdue > 0 ? ` · ${overdue} просрочена` : ''}`
      : 'Книг нет';

  if (adminOpen) {
    return (
      <AdminScreen
        profile={p}
        initial={adminSection}
        onClose={() => {
          setAdminOpen(false);
          setAdminSection('menu');
        }}
      />
    );
  }

  if (hiddenOpen) return <HiddenMenuScreen onBack={() => setHiddenOpen(false)} />;

  return (
    <>
      <Page
        header={
          <Header
            title="Кабинет"
            kicker="Личный кабинет"
            large
            // Почта перечитывается при каждом заходе — её в счётчик не берём
            // (иначе спиннер мигал бы постоянно и ничего не значил). Здесь видно
            // обновление разделов БАРС.
            right={
              <>
                {p.isAdmin ? (
                  <button
                    type="button"
                    aria-label="Администрирование"
                    onClick={() => {
                      haptic('light');
                      setAdminSection('menu');
                      setAdminOpen(true);
                    }}
                    className="pressable rounded-full p-2 active:pressable-active"
                    style={{ color: 'var(--accent)' }}
                  >
                    <Settings size={19} aria-hidden />
                  </button>
                ) : null}
                <RefreshIndicator active={barsRefreshing && !pull.suppressBackground} />
              </>
            }
          />
        }
        pull={pull}
      >
        <div className="space-y-3">
          {/* Профиль. Десять тапов по карточке открывают скрытый экран. */}
          <Card
            className="relative overflow-hidden px-5 py-5"
            style={{ border: '1px solid var(--separator-soft)' }}
            onPress={handleProfileTap}
            silent
          >
            <div
              className="pointer-events-none absolute -right-12 -top-20 h-48 w-48 rounded-full"
              style={{
                background: 'radial-gradient(circle, var(--accent-soft) 0%, transparent 70%)',
              }}
              aria-hidden
            />

            <div className="relative flex items-center gap-4">
              <div
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-[19px] font-semibold"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                aria-hidden
              >
                {initials || 'С'}
              </div>

              <div className="min-w-0 flex-1">
                <p className="truncate text-[19px] font-semibold leading-tight">{p.fullName}</p>
                {p.groupName ? (
                  <p className="mt-0.5 text-[14px] font-medium" style={{ color: 'var(--accent)' }}>
                    {p.groupName}
                  </p>
                ) : null}
                {p.recordBookNumber || p.faculty ? (
                  <p className="mt-0.5 truncate text-[12px] text-[var(--text-tertiary)]">
                    {p.recordBookNumber ? `Зачётная книжка ${p.recordBookNumber}` : ''}
                    {p.recordBookNumber && p.faculty ? ' · ' : ''}
                    {p.faculty ?? ''}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="relative mt-3 flex flex-wrap gap-1.5">
              {typeof p.telegramId === 'number' ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  style={{ background: 'rgba(52,199,89,0.12)', color: 'var(--success)' }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--success)' }} />
                  Telegram подключён
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  style={{ background: 'var(--surface-grouped)', color: 'var(--text-tertiary)' }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--text-tertiary)' }} />
                  Telegram не подключён
                </span>
              )}
            </div>
          </Card>

          {/* Почта — первая строка после профиля */}
          <button
            type="button"
            onClick={() => {
              haptic('light');
              openLink('https://mail.mpei.ru/owa');
            }}
            className="pressable flex w-full items-center gap-3 rounded-[18px] border px-4 py-3.5 text-left active:pressable-active"
            style={{
              borderColor: 'var(--accent-soft)',
              background:
                'radial-gradient(110% 120% at 100% 0%, var(--accent-soft), transparent 58%), var(--surface)',
            }}
            aria-label="Открыть почту ОСЭП"
          >
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px]"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              aria-hidden
            >
              <Mail size={20} />
            </span>

            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold leading-snug">Почта ОСЭП</span>
              <span
                className="mt-0.5 block truncate text-[12px] leading-snug"
                style={{ color: mailError ? 'var(--danger)' : 'var(--text-secondary)' }}
              >
                {mailError
                  ? mailError
                  : mailPending
                    ? 'Проверяем…'
                    : unseen > 0
                      ? `${unseen} ${plural(unseen, 'новое письмо', 'новых письма', 'новых писем')}`
                      : 'Нет новых писем'}
              </span>
            </span>

            {unseen > 0 ? (
              <span
                className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-bold text-white"
                style={{ background: 'var(--accent)' }}
              >
                {unseen > 9 ? '9+' : unseen}
              </span>
            ) : null}

            <span
              className="hidden shrink-0 items-center gap-0.5 text-[11px] font-semibold min-[360px]:inline-flex"
              style={{ color: 'var(--accent)' }}
            >
              Открыть
              <ArrowUpRight size={12} aria-hidden />
            </span>
          </button>

          <h2 className="px-1 pt-2 text-[12px] font-semibold uppercase tracking-[0.09em] text-[var(--text-secondary)]">
            Учёба
          </h2>

          {morePending ? (
            <div className="space-y-2">
              <SkeletonCard lines={2} />
              <SkeletonCard lines={2} />
              <SkeletonCard lines={2} />
            </div>
          ) : moreError ? (
            <Card className="px-4 py-4">
              <p className="text-[13px] leading-snug" style={{ color: 'var(--danger)' }}>
                {moreError}
              </p>
            </Card>
          ) : (
            <div className="space-y-2">
              <StudySection
                icon={GraduationCap}
                title="Стипендии"
                subtitle={scholarshipSubtitle}
                tone="success"
                badge={
                  scholarships.length > 0 ? (
                    <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                      {scholarships.length}
                    </span>
                  ) : null
                }
              >
                {scholarships.length > 0 ? (
                  scholarships.map((item, index) => (
                    <StudyLine key={`${item.type}-${item.period ?? ''}-${index}`}>
                      <p
                        className="text-[14px] font-semibold leading-snug"
                        style={{ opacity: item.isActive ? 1 : 0.55 }}
                      >
                        {item.type}
                      </p>
                      {item.period ? (
                        <p className="mt-0.5 text-[12px] leading-snug text-[var(--text-secondary)]">
                          {item.period}
                        </p>
                      ) : null}
                      {item.amount ? (
                        <p className="mt-0.5 text-[12px] leading-snug text-[var(--text-secondary)]">
                          {item.amount}
                        </p>
                      ) : null}
                      <p
                        className="mt-1 text-[11px] font-semibold"
                        style={{ color: item.isActive ? 'var(--success)' : 'var(--text-tertiary)' }}
                      >
                        {item.isActive ? '● активна' : 'Не действует'}
                      </p>
                    </StudyLine>
                  ))
                ) : (
                  <p className="py-2 text-[13px] text-[var(--text-secondary)]">
                    Стипендия не назначена
                  </p>
                )}
              </StudySection>

              <StudySection
                icon={ScrollText}
                title="Приказы"
                subtitle={ordersSubtitle}
                badge={
                  orders.length > 0 ? (
                    <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: 'var(--surface-grouped)', color: 'var(--text-secondary)' }}>
                      {orders.length}
                    </span>
                  ) : null
                }
              >
                {orders.length > 0 ? (
                  orders.map((order, index) => (
                    <StudyLine key={`${order.number}-${index}`}>
                      <p className="text-[14px] leading-snug">{order.title}</p>
                      <p className="mt-0.5 text-[12px] text-[var(--text-tertiary)]">
                        № {order.number}
                        {order.date ? ` · ${order.date}` : ''}
                      </p>
                    </StudyLine>
                  ))
                ) : (
                  <p className="py-2 text-[13px] text-[var(--text-secondary)]">Приказов нет</p>
                )}
              </StudySection>

              <StudySection
                icon={BookOpen}
                title="Библиотека НТБ"
                subtitle={librarySubtitle}
                tone={overdue > 0 ? 'warning' : 'accent'}
                badge={
                  overdue > 0 ? (
                    <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: 'rgba(255,59,48,0.1)', color: 'var(--danger)' }}>
                      {overdue}
                    </span>
                  ) : null
                }
              >
                {books.length > 0 ? (
                  books.map((book, index) => (
                    <StudyLine key={`${book.title}-${index}`}>
                      <p
                        className="text-[14px] leading-snug"
                        style={{ color: book.isOverdue ? 'var(--danger)' : undefined }}
                      >
                        {book.title}
                      </p>
                      {book.author ? (
                        <p className="mt-0.5 text-[12px] text-[var(--text-tertiary)]">{book.author}</p>
                      ) : null}
                      <p
                        className="mt-0.5 text-[12px]"
                        style={{ color: book.isOverdue ? 'var(--danger)' : 'var(--text-tertiary)' }}
                      >
                        Вернуть до {book.dueDate}
                        {book.isOverdue ? ' — просрочено' : ''}
                      </p>
                    </StudyLine>
                  ))
                ) : (
                  <p className="py-2 text-[13px] text-[var(--text-secondary)]">Книг нет</p>
                )}
              </StudySection>
            </div>
          )}

          <h2 className="px-1 pt-2 text-[12px] font-semibold uppercase tracking-[0.09em] text-[var(--text-secondary)]">
            Настройки приложения
          </h2>
          <PushPrompt />
          <SettingsCard profile={p} />

          <h2 className="px-1 pt-2 text-[12px] font-semibold uppercase tracking-[0.09em] text-[var(--text-secondary)]">
            Контакты и код
          </h2>
          <Card className="divide-y divide-[var(--separator-soft)] overflow-hidden">
            <button
              type="button"
              onClick={() => {
                haptic('light');
                openLink('https://t.me/mood_mpei_sup');
              }}
              className="pressable flex w-full items-center gap-3 px-4 py-3 text-left active:pressable-active"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }} aria-hidden>
                <MessageCircle size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium">Поддержка</span>
                <span className="block text-[12px] text-[var(--text-tertiary)]">@mood_mpei_sup</span>
              </span>
              <ChevronRight size={16} className="shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden />
            </button>

            <button
              type="button"
              onClick={() => {
                haptic('light');
                openLink('https://t.me/mood_mpei');
              }}
              className="pressable flex w-full items-center gap-3 px-4 py-3 text-left active:pressable-active"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }} aria-hidden>
                <Send size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium">Telegram-канал Mood</span>
                <span className="block text-[12px] text-[var(--text-tertiary)]">@mood_mpei</span>
              </span>
              <ChevronRight size={16} className="shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden />
            </button>

            <button
              type="button"
              onClick={() => {
                haptic('light');
                openLink('https://github.com/SPARTANEC08/mood');
              }}
              className="pressable flex w-full items-center gap-3 px-4 py-3 text-left active:pressable-active"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }} aria-hidden>
                <GitBranch size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium">Исходный код</span>
                <span className="block text-[12px] text-[var(--text-tertiary)]">SPARTANEC08/mood</span>
              </span>
              <ChevronRight size={16} className="shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden />
            </button>
          </Card>

          <div className="flex items-center justify-between gap-3 px-2 pt-4">
            <button
              type="button"
              onClick={() => {
                haptic('medium');
                void logout();
              }}
              className="pressable text-[12px] font-semibold active:pressable-active"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Выйти с устройства
            </button>
            <DeleteAccountCard />
          </div>

          <p className="px-1 pt-3 text-center text-[11px] leading-relaxed text-[var(--text-tertiary)]">
            Mood · БАРС МЭИ · ОСЭП
          </p>
        </div>
      </Page>

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}

/** Полноэкранный экран для случая «нет входа в БАРС». */
export function NeedLoginScreen({ onReLogin }: { onReLogin: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 py-10 text-center">
      <div
        className="mb-4 flex h-16 w-16 items-center justify-center rounded-full"
        style={{ background: 'var(--accent-soft)' }}
        aria-hidden
      >
        <GraduationCap size={30} style={{ color: 'var(--accent)' }} />
      </div>

      <h1 className="text-[22px] font-semibold tracking-tight">Нужен вход в БАРС</h1>
      <p className="mt-2 max-w-[320px] text-[15px] leading-relaxed text-[var(--text-secondary)]">
        Сессия личного кабинета НИУ МЭИ истекла. Расписание, оценки и почта появятся снова
        после входа логином и паролем БАРС.
      </p>

      {/*
        Вход прямо здесь, а не переход в бота: в PWA учётные данные — собственные,
        и требовать ради этого запускать Telegram было бы возвратом к старой схеме.
        Заодно это работает у человека вообще без Telegram.
      */}
      <button
        type="button"
        onClick={() => {
          haptic('medium');
          onReLogin();
        }}
        className="pressable mt-6 rounded-[14px] bg-[var(--accent)] px-6 py-3 text-[17px] font-semibold text-white active:pressable-active"
      >
        Войти заново
      </button>

      <button
        type="button"
        onClick={() => {
          haptic('light');
          openLink('https://t.me/mood_mpei_bot');
        }}
        className="pressable mt-2 rounded-[12px] px-4 py-2 text-[14px] font-semibold text-[var(--text-tertiary)] active:pressable-active"
      >
        Можно и в боте
      </button>
    </div>
  );
}
