/**
 * Сетевой заход за данными одного пользователя: БАРС и почта ОСЭП.
 *
 * Каждый блок изолирован: падение почты не должно обнулять оценки, а падение
 * БАРСа — считаться сетевой ошибкой и откладывать обновление снимка. Источники
 * опрашиваются только те, что `due` по графику частот.
 */

import { createBarsServiceForUser, readOwaCredentials } from '../../bars/barsServiceFactory.ts';
import type { SemesterGrades } from '../../bars/parsers/gradesParser.js';
import type { OrderItem, ScholarshipInfo } from '../../bars/parsers/studentInfoParser.js';
import { MailAuthError } from '../../mail/mailErrors.ts';
import { OwaMailClient } from '../../mail/owaMailClient.ts';
import type { OsepMessageBrief } from '../../mail/types.js';
import type { StoredUser } from '../../../storage/userStore.ts';
import { userStore } from '../../../storage/userStore.ts';
import { safeErrorMessage } from '../../../bot/format.ts';
import { dueSources, type Source } from '../pollSchedule.ts';

export interface CollectedState {
  grades: SemesterGrades | null;
  orders: OrderItem[] | null;
  scholarship: ScholarshipInfo | null;
  mails: OsepMessageBrief[] | null;
}

/**
 * Что реально удалось собрать на этом круге. Незапрошенные источники остаются
 * null, и в снимке сохраняются прежние значения — иначе пропущенный круг
 * обнулил бы приказы и стипендию и вызвал бы ложное уведомление.
 */
export interface FetchResult {
  state: CollectedState;
  fetched: Source[];
}

/**
 * Выполняет сетевой заход по данным пользователя.
 *
 * Каждый блок изолирован: падение почты не должно обнулять оценки.
 * Источники опрашиваются только те, что `due` по графику частот.
 */
export async function collectState(user: StoredUser, now: Date): Promise<FetchResult> {
  const sources = dueSources(user.userId, now);
  if (sources.length === 0) {
    return { state: { grades: null, orders: null, scholarship: null, mails: null }, fetched: [] };
  }

  const state: CollectedState = { grades: null, orders: null, scholarship: null, mails: null };
  const service = await createBarsServiceForUser(user);
  const scraper = service.getScraper();

  const barsJobs: Promise<void>[] = [];

  // Оценки. Разбор страницы — 9.8 мс, из них 5.1 мс уходит на cheerio.load.
  // Пропускать разбор по хешу HTML не стали: выигрыш копеечный, а проверка
  // протухшей сессии живёт внутри cheerio-разбора, и подмена её на регулярки
  // грозит тихой поломкой (бот будет биться в стену вместо запроса нового входа).
  if (sources.includes('grades')) {
    barsJobs.push(
      scraper.getCurrentSemesterGrades().then((grades) => {
        state.grades = grades;
      }),
    );
  }

  // Приказы и стипендия меняются от раза к разу в семестр.
  if (sources.includes('info')) {
    barsJobs.push(
      scraper.getOrders().then((orders) => {
        state.orders = orders;
      }),
    );
    barsJobs.push(
      scraper.getScholarship().then((scholarship) => {
        state.scholarship = scholarship;
      }),
    );
  }

  // Почта ОСЭП (OWA). Отдельный блок: ошибки не влияют на БАРС. Ходим только
  // когда `mail` due. Источник — веб-интерфейс mail.mpei.ru/owa (IMAP :993
  // режется TMG). Сессия OWA переиспользуется из `StoredUser.owaAuth`; после
  // входа свежие cookies сохраняем, а при отказе входа — забываем.
  const mailJob = sources.includes('mail')
    ? (async () => {
        try {
          const { login, password } = readOwaCredentials(user);
          const mail = new OwaMailClient(
            { user: login, pass: password },
            { cookiesJson: user.owaAuth?.cookiesJson },
          );
          state.mails = await mail.fetchMessageBriefs({ onlyUnread: false, limit: 15 });
          userStore.setOwaAuth(user.userId, mail.serializeCookies());
        } catch (err: unknown) {
          if (err instanceof MailAuthError) {
            // Сессия/пароль не подошли: чистим owaAuth, следующий круг войдёт заново.
            userStore.clearOwaAuth(user.userId);
          }
          console.warn('[Notifier] почта OWA недоступна, пропускаю:', safeErrorMessage(err));
        }
      })()
    : Promise.resolve();

  const [barsResults] = await Promise.all([
    Promise.allSettled(barsJobs),
    mailJob,
  ]);

  // БАРС целиком недоступен — считаем это сетевой ошибкой, снимок не обновляем.
  const barsErrors = barsResults
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason);

  if (barsErrors.length > 0) {
    const first = barsErrors[0];
    throw first instanceof Error ? first : new Error(String(first ?? 'БАРС недоступен'));
  }

  // Неуспешный IMAP-запрос оставляет mail due: следующий цикл попробует ещё
  // раз вместо того, чтобы считать почту проверенной и терять целый интервал.
  const fetched = sources.filter((source) => source !== 'mail' || state.mails !== null);

  return {
    state,
    fetched,
  };
}
