import {
  BookOpen,
  CircleCheck,
  GraduationCap,
  LogOut,
  Mail,
  MessageCircle,
  RefreshCw,
  Send,
  ScrollText,
  TriangleAlert,
} from 'lucide-react';

import { Header } from '@/components/TabBar';
import { Page } from '@/components/Page';
import { Card, EmptyState, ListGroup, Row, SkeletonCard } from '@/components/ui';
import { NotificationsCard } from '@/components/profile/NotificationsCard';
import { useAppData } from '@/lib/dataContext';
import { haptic, openLink } from '@/lib/env';
import { logout } from '@/auth';
import type { BootstrapResponse } from '@/types/api';

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
  } = useAppData();

  // Блоки рендерятся сразу; тяжёлые данные дозаполняются. Пока данных нет и
  // ошибки тоже нет — показываем скелет соответствующего блока, а не ложное
  // «писем нет»/«стипендия не назначена» на первом кадре захода на вкладку.
  const mailPending = !mail && !mailError;
  const morePending = !more && !moreError;

  const { profile: p, barsAuthorized } = profile;

  const initials = p.fullName
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  const overdue = more?.libraryBooks.filter((b) => b.isOverdue).length ?? 0;

  return (
    <Page
      header={
        <Header
          title="Кабинет"
          large
          right={
            <button
              type="button"
              aria-label="Обновить"
              onClick={() => {
                haptic('light');
                refreshBars();
              }}
              className="pressable rounded-full p-2 active:pressable-active"
              style={{ color: 'var(--accent)' }}
            >
              <RefreshCw
                size={19}
                className={barsRefreshing ? 'spinner' : undefined}
                aria-hidden
              />
            </button>
          }
        />
      }
    >
      <div className="space-y-4">
        {/* Профиль */}
        <Card className="px-5 py-5">
          <div className="flex items-center gap-4">
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
                <p className="mt-0.5 text-[14px]" style={{ color: 'var(--accent)' }}>
                  {p.groupName}
                </p>
              ) : null}
              {p.recordBookNumber ? (
                <p className="mt-0.5 text-[12px] text-[var(--text-tertiary)]">
                  Зачётная книжка {p.recordBookNumber}
                </p>
              ) : null}
            </div>
          </div>

          {p.faculty ? (
            <p className="mt-3 border-t border-[var(--separator-soft)] pt-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
              {p.faculty}
            </p>
          ) : null}

          {!barsAuthorized ? (
            <div
              className="mt-3 flex items-start gap-2 rounded-[12px] px-3 py-2.5"
              style={{ background: 'var(--warning)', opacity: 0.12 }}
            >
              <TriangleAlert size={15} className="mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} aria-hidden />
              <p className="text-[13px] leading-relaxed">
                Не выполнен вход в БАРС МЭИ — часть данных недоступна. Войдите через бота.
              </p>
            </div>
          ) : null}
        </Card>

        {/* Почта ОСЭП */}
        <section>
          <h2 className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
            Почта ОСЭП
          </h2>

          {mailPending ? (
            <div className="space-y-2.5">
              <SkeletonCard lines={1} />
              <SkeletonCard lines={1} />
              <SkeletonCard lines={1} />
            </div>
          ) : mailError ? (
            // Ошибка может прийти только от транспорта (сеть/сессия): почту
            // обновляет нотификатор, кнопки ручного повтора нет намеренно.
            <Card className="px-4 py-4">
              <div className="flex items-center gap-2">
                <Mail size={16} style={{ color: 'var(--danger)' }} aria-hidden />
                <p className="flex-1 text-[13px]" style={{ color: 'var(--danger)' }}>
                  {mailError}
                </p>
              </div>
            </Card>
          ) : mail && mail.messages.length > 0 ? (
            <ListGroup>
              {mail.messages.map((message) => (
                <Row key={message.uid}>
                  <div className="flex items-start gap-3">
                    <Mail
                      size={15}
                      className="mt-0.5 shrink-0"
                      style={{ color: message.isSeen ? 'var(--text-tertiary)' : 'var(--accent)' }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[14px] font-medium">{message.from}</span>
                        <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                          {formatTime(message.date)}
                        </span>
                      </div>
                      <p
                        className="mt-0.5 truncate text-[13px]"
                        style={{ color: message.isSeen ? 'var(--text-secondary)' : 'var(--text-primary)' }}
                      >
                        {message.subject}
                      </p>
                    </div>
                  </div>
                </Row>
              ))}
            </ListGroup>
          ) : (
            <EmptyState icon={<Mail size={30} aria-hidden />} title="Непрочитанных писем нет" />
          )}

        </section>

        <NotificationsCard profile={p} />

        {/* Стипендия */}
        <section>
          <h2 className="mb-2 mt-6 px-1 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
            Стипендия
          </h2>

          {morePending ? (
            <SkeletonCard lines={2} />
          ) : moreError ? (
            <Card className="px-4 py-4">
              <p className="text-[13px]" style={{ color: 'var(--danger)' }}>
                {moreError}
              </p>
            </Card>
          ) : more ? (
            <Card className="flex items-center gap-3 px-4 py-4">
              {more.scholarship.isAppointed ? (
                <CircleCheck size={22} style={{ color: 'var(--success)' }} aria-hidden />
              ) : (
                <GraduationCap size={22} style={{ color: 'var(--text-tertiary)' }} aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium">
                  {more.scholarship.isAppointed
                    ? (more.scholarship.type ?? 'Стипендия назначена')
                    : 'Стипендия не назначена'}
                </p>
                {more.scholarship.period ? (
                  <p className="mt-0.5 text-[13px] text-[var(--text-secondary)]">
                    Период: {more.scholarship.period}
                  </p>
                ) : null}
                {more.scholarship.amount ? (
                  <p className="mt-0.5 text-[13px] text-[var(--text-secondary)]">
                    Сумма: {more.scholarship.amount}
                  </p>
                ) : null}
              </div>
            </Card>
          ) : null}
        </section>

        {/* Приказы */}
        {more && more.orders.length > 0 ? (
          <section>
            <h2 className="mb-2 mt-6 px-1 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
              Приказы
            </h2>
            <ListGroup>
              {more.orders.slice(0, 8).map((order, index) => (
                <Row key={`${order.number}-${index}`}>
                  <div className="flex items-start gap-3">
                    <ScrollText size={15} className="mt-0.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] leading-snug">{order.title}</p>
                      <p className="mt-0.5 text-[12px] text-[var(--text-tertiary)]">
                        № {order.number}
                        {order.date ? ` · ${order.date}` : ''}
                      </p>
                    </div>
                  </div>
                </Row>
              ))}
            </ListGroup>
          </section>
        ) : null}

        {/* Библиотека */}
        {more && more.libraryBooks.length > 0 ? (
          <section>
            <h2 className="mb-2 mt-6 flex items-center justify-between px-1 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
              <span>Библиотека НТБ</span>
              {overdue > 0 ? (
                <span className="text-[12px] font-medium normal-case" style={{ color: 'var(--danger)' }}>
                  просрочено: {overdue}
                </span>
              ) : null}
            </h2>
            <ListGroup>
              {more.libraryBooks.map((book, index) => (
                <Row key={`${book.title}-${index}`}>
                  <div className="flex items-start gap-3">
                    <BookOpen
                      size={15}
                      className="mt-0.5 shrink-0"
                      style={{ color: book.isOverdue ? 'var(--danger)' : 'var(--text-tertiary)' }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] leading-snug">{book.title}</p>
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
                    </div>
                  </div>
                </Row>
              ))}
            </ListGroup>
          </section>
        ) : null}

        <section className="space-y-2">
          <h2 className="px-1 text-[13px] font-semibold text-[var(--text-secondary)]">Связь</h2>
          <Card className="divide-y divide-[var(--separator-soft)] overflow-hidden">
            <button
              type="button"
              onClick={() => {
                haptic('light');
                openLink('https://t.me/spartanec_0');
              }}
              className="pressable flex w-full items-center gap-3 px-4 py-3 text-left active:pressable-active"
            >
              <MessageCircle size={18} className="shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium">Поддержка и сообщения об ошибках</span>
                <span className="block text-[12px] text-[var(--text-tertiary)]">@spartanec_0</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                haptic('light');
                openLink('https://t.me/hub_mpei');
              }}
              className="pressable flex w-full items-center gap-3 px-4 py-3 text-left active:pressable-active"
            >
              <Send size={18} className="shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium">Telegram-канал Hub</span>
                <span className="block text-[12px] text-[var(--text-tertiary)]">@hub_mpei</span>
              </span>
            </button>
          </Card>
        </section>

        {/*
          Выход с устройства.
          
          Отзывается ровно этот токен, а не все: человек вправе быть подписан на
          телефоне и на ноутбуке, и выход на одном устройстве не должен выкидывать
          его с другого. В боте выход делает другое — освобождает логин БАРС для
          входа в PWA.
        */}
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => {
              haptic('medium');
              void logout();
            }}
            className="pressable flex items-center gap-1.5 rounded-[12px] border border-[var(--separator-soft)] px-4 py-2 text-[13px] font-semibold text-[var(--text-secondary)] active:pressable-active"
          >
            <LogOut size={13} aria-hidden />
            Выйти с этого устройства
          </button>
        </div>

        <p className="px-1 pt-4 text-center text-[12px] leading-relaxed text-[var(--text-tertiary)]">
          Данные из личного кабинета БАРС МЭИ и корпоративной почты ОСЭП.
          <br />
          Сессия истекает — обновите её, войдя заново логином БАРС.
        </p>
      </div>
    </Page>
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
          openLink('https://t.me/hub_mpei_bot');
        }}
        className="pressable mt-2 rounded-[12px] px-4 py-2 text-[14px] font-semibold text-[var(--text-tertiary)] active:pressable-active"
      >
        Можно и в боте
      </button>
    </div>
  );
}

/** «9 окт, 14:30» → «9 окт» или «сегодня» */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${date.getDate()} ${months[date.getMonth()]}`;
}
