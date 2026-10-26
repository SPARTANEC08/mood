/**
 * Полное удаление аккаунта и всех связанных с ним данных.
 *
 * ── Почему это отдельный сервис, а не DELETE в маршруте ─────────────────────
 *
 * У одного человека данные лежат в users, user_events, homework_done, в
 * records (снимок БАРС, админы, FSM бота, ДЗ и «Важное») и в документах
 * announcements/stats_window. Плюс файлы на диске и несколько кэшей в памяти.
 * Если удалить только строку users, останется «хвост», который виден в /dev,
 * в списке админов или в чужих записях как автор.
 *
 * Все хранилища ниже — это SQLite (`JsonStore`/`JsonDocument` поверх таблиц
 * records/documents/users). Поэтому удаление идёт через их API: он обновляет и
 * строку в базе, и кэш процесса, иначе удалённый пользователь ещё жил бы в
 * памяти до рестарта.
 *
 * ── Что удаляется ───────────────────────────────────────────────────────────
 *
 * - запись users: креды БАРС, сессия OWA, PWA-токены, профиль, согласия;
 * - файлы пользователя на диске и ссылки на них в чужих записях;
 * - ДЗ и «Важное», созданные пользователем (это его авторский контент);
 * - снимок БАРС и история уведомлений;
 * - личные отметки «Сделано»;
 * - объявления, созданные пользователем, и его отметки о закрытии чужих;
 * - назначение админом и незавершённый FSM бота;
 * - участие в статистике /dev и файловый кэш статистики;
 * - кэши БАРС, OWA, расписания опроса и почтовых счётчиков.
 *
 * Запись users удаляется последней: если удаление файлов упало, аккаунт ещё
 * существует, и человек может повторить действие, не потеряв доступ.
 */

import { userStore, type StoredUser } from '../../../db/storage/userStore.ts';
import { snapshotStore } from '../../../db/storage/snapshotStore.ts';
import { userEventStore } from '../../../db/storage/userEventStore.ts';
import { homeworkDoneStore } from '../../../db/storage/homeworkDoneStore.ts';
import { homeworkStore } from '../../../db/storage/homeworkStore.ts';
import { importantStore } from '../../../db/storage/importantStore.ts';
import { announcementStore } from '../../../db/storage/announcementStore.ts';
import { botFlowsStore } from '../../../db/storage/botFlowsStore.ts';
import { removeAdmin } from '../../../db/storage/adminsStore.ts';
import { deleteAllFiles } from '../../../db/storage/fileStore.ts';
import { forgetUser as forgetStatsUser } from '../../server/devStats.ts';
import { forgetBarsClient, forgetBarsSessionValid } from '../bars/barsServiceFactory.ts';
import { invalidateBarsSnapshot } from '../bars/barsSnapshotCache.ts';
import { clearMailStatus } from '../mail/mailStatusCache.ts';
import { forgetOwaClient } from '../mail/owaClientRegistry.ts';
import { forget as forgetPollSchedule } from '../notifications/pollSchedule.ts';

/** Убирает ссылки на файлы пользователя из оставшихся записей группы. */
function removeFileRefs<T extends { files: Array<{ uploadedBy: string }> }>(
  records: T[],
  save: (record: T) => void,
  userId: string,
): void {
  for (const record of records) {
    const files = record.files.filter((file) => file.uploadedBy !== userId);
    if (files.length !== record.files.length) save({ ...record, files });
  }
}

export async function deleteAccount(user: StoredUser): Promise<void> {
  const userId = user.userId;
  const telegramId = typeof user.telegramId === 'number' ? user.telegramId : null;

  // 1. Файлы — первыми. Если диск не дал удалить, аккаунт не трогаем:
  // пользователь повторит попытку, и никаких «полуудалённых» записей не будет.
  await deleteAllFiles(userId);

  // 2. Авторский контент. ДЗ и «Важное» принадлежат группе, но автор — этот
  // человек, поэтому после удаления аккаунта они не должны остаться с его
  // именем и вложенными файлами.
  for (const record of homeworkStore.all()) {
    if (record.authorId !== userId) continue;
    // Чужие отметки «Сделано» ссылаются на это задание. Удаляем и их, иначе
    // после удаления автора у одногруппников остались бы битые идентификаторы.
    homeworkDoneStore.removeForHomework(record.id);
    homeworkStore.delete(record.id);
  }
  for (const record of importantStore.all()) {
    if (record.authorId === userId) importantStore.delete(record.id);
  }

  // 3. У оставшихся записей убираем ссылки на файлы удалённого пользователя:
  // сами файлы уже стёрты, иначе карточка показывала бы битую ссылку.
  removeFileRefs(homeworkStore.all(), (record) => homeworkStore.save(record), userId);
  removeFileRefs(importantStore.all(), (record) => importantStore.save(record), userId);

  // 4. Объявления админа и отметки о закрытии.
  if (telegramId !== null) announcementStore.removeByCreator(telegramId);
  announcementStore.forgetUser(userId);

  // 5. Персональные снимки, события и отметки выполнения.
  snapshotStore.remove(userId);
  snapshotStore.flush();
  userEventStore.clearForUser(userId);
  homeworkDoneStore.clearForUser(userId);

  // 6. Бот: состояние диалога и назначенные права.
  if (telegramId !== null) {
    botFlowsStore.delete(telegramId);
    removeAdmin(telegramId);
  }

  // 7. Кэши в памяти. Без этого удалённый человек мог бы ещё минут двадцать
  // отдаваться из снимка БАРС или считаться в опросе почты.
  forgetBarsClient(userId);
  forgetBarsSessionValid(userId);
  invalidateBarsSnapshot(userId);
  forgetOwaClient(userId);
  clearMailStatus(userId);
  forgetPollSchedule(userId);

  // 8. Статистика: минутные корзины, последняя активность, кэш файлов.
  forgetStatsUser(userId);

  // 9. Сама запись — последней.
  userStore.remove(userId);
}
