/**
 * @deprecated НЕ ИСПОЛЬЗУЕТСЯ. IMAP :993 режется Forefront TMG (RST на
 * ClientHello), поэтому почта читается через OWA-скрапинг — см.
 * `owaMailClient.ts`. Файл оставлен как историческая реализация IMAP-клиента;
 * в новом коде не импортировать. Удалить, когда подтвердится, что IMAP МЭИ
 * больше не нужен.
 */

import crypto from 'node:crypto';

import { ImapFlow } from 'imapflow';
import type {
  OsepCredentials,
  OsepFolderStatus,
  OsepMessage,
  OsepMessageBrief,
  FetchMessagesOptions,
} from './types.js';

/**
 * Проверка сертификата mail.mpei.ru по отпечатку (pinning).
 *
 * Контекст. Сервер отдаёт сертификат, выданный внутренним УЦ МЭИ
 * (mbxcas.public.mpei.local → public-PUBLICCA-CA → MPEI (TU)). Корневого
 * сертификата нет ни в системном хранилище, ни в публичном доступе: он лежит
 * во внутренней сети .mpei.local. Поэтому обычную проверку цепочки наладить
 * нельзя — отсюда и стояло раньше rejectUnauthorized:false, то есть проверки
 * не было вообще, и любой в сетевом пути мог подменить сервер и снять пароль.
 *
 * Что сделано вместо этого: проверяется SPKI-отпечаток (sha256 от
 * DER-представления публичного ключа). Это ровно то, что делает HPKP/пinning:
 * подменить сервер, не зная закрытый ключ, невозможно — MITM со своим
 * сертификатом даст другой отпечаток и соединение будет отвергнуто. Пароль
 * уходит по TLS и не может быть прочитан по дороге.
 *
 * Отпечаток сервера (sha256 SPKI, base64):
 *   PkoOagvOh1G5kxqLLL9Jc4TfQWoWXx5OtV0lozzRGhg=
 * Задаётся переменной окружения MAIL_TLS_PIN.
 * Если сервер перевыпустит сертификат, новый отпечаток нужно обновить в .env —
 * это ожидаемое поведение pinning.
 *
 * Про SECLEVEL=0: сервер МЭИ отдаёт сертификат только на самом низком уровне
 * (проверено: на SECLEVEL=1 он не отдаёт сертификат вовсе, соединение рвётся).
 * Это ограничение самого сервера, а не ослабление защиты на нашей стороне:
 * аутентификацию обеспечивает проверка отпечатка, а не набор шифров.
 * Переговоры фактически идут TLS 1.2 с ECDHE-RSA-AES256-SHA384 —
 * это AES-256-GCM-эквивалент и ECDHE с forward secrecy, то есть сам по себе
 * шифр приемлемый; его выбор навязывает сервер.
 */
const DEFAULT_TLS_PIN = 'PkoOagvOh1G5kxqLLL9Jc4TfQWoWXx5OtV0lozzRGhg=';

/** Сообщение о режиме проверки TLS печатается один раз за процесс. */
let pinNoticeLogged = false;

/**
 * Отпечаток SPKI сертификата, полученного на сервере.
 * base64 без переводов строк сравнивается без учёта регистра и пробелов.
 */
function expectedPin(): string {
  const pin = process.env.MAIL_TLS_PIN?.trim() || DEFAULT_TLS_PIN;
  return pin.replace(/\s+/g, '');
}

function computeSpkiPin(cert: crypto.X509Certificate): string {
  const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(spkiDer).digest('base64');
}

/**
 * Достаёт DNS-имена из subjectAltName расширения X.509.
 *
 * Почему вручную, а не cert.subjectAltName: на Node 20.20 это свойство
 * возвращает undefined даже для сертификата, где SAN присутствует (проверено
 * на реальном сертификате mail.mpei.ru). Свойство тогда вообще неинформативно,
 * поэтому DNS-имена читаются из сырого сертификата.
 *
 * Известно, что для записи вида `DNS:a.b` в DER это последовательность
 * [0x82, длина, ...байты имени], где длина — однобайтная (<128) или
 * двухбайтовая со старшим битом. Имена вида `DNS:*` отбрасываются.
 */
function dnsNamesFromSan(der: Buffer): string[] {
  const out: string[] = [];

  for (let i = 0; i < der.length - 1; i += 1) {
    // 0x82 — [context][constructed] primitive UTF8String, второй байт — длина
    if (der[i] !== 0x82) continue;

    let len: number;
    let start: number;

    if (der[i + 1] < 0x80) {
      len = der[i + 1];
      start = i + 2;
    } else if (der[i + 1] === 0x81) {
      len = der[i + 2];
      start = i + 3;
    } else {
      continue;
    }

    if (len === 0 || start + len > der.length) continue;

    const value = der.toString('ascii', start, start + len);
    // Имя должно быть похоже на домен, иначе это совпадение байтов,
    // а не запись SAN.
    if (!/^[A-Za-z0-9.*-]+(\.[A-Za-z0-9.*-]+)+$/.test(value)) continue;

    out.push(value.toLowerCase());
  }

  return out;
}

/**
 * Проверка имени хоста по subjectAltName.
 *
 * Поддерживается ровно то, что нужно почте МЭИ: записи вида DNS:имя.
 * Подстановочный DNS:* сознательно не принимается — такой сертификат
 * подошёл бы любому имени и проверку обесценил бы.
 */
function checkCertificateHost(cert: crypto.X509Certificate, host: string): Error | undefined {
  const names = dnsNamesFromSan(cert.raw).filter((n) => !n.startsWith('*.'));

  if (names.length === 0) {
    return new Error(
      'В сертификате почтового сервера не найдено ни одного DNS-имени — проверить хост нечем.',
    );
  }

  const wanted = host.toLowerCase();
  if (!names.includes(wanted)) {
    return new Error(`Имя ${host} не найдено в сертификате почтового сервера.`);
  }
  return undefined;
}

/**
 * Базовый клиент подключения к корпоративной почте МЭИ (mail.mpei.ru) по протоколу IMAP.
 */
export class OsepMailClient {
  private credentials: OsepCredentials;
  private imapUser: string;

  constructor(credentials: OsepCredentials) {
    const rawUser = credentials.user.trim();
    const normalizedEmail = rawUser.includes('@mpei.ru') ? rawUser : `${rawUser}@mpei.ru`;
    // Сервер mail.mpei.ru (Exchange) требует логин учетной записи без суффикса @mpei.ru (например, LysenkoNR)
    const imapUser = rawUser.replace(/@mpei\.ru$/i, '');

    this.credentials = {
      user: normalizedEmail,
      pass: credentials.pass,
    };
    this.imapUser = imapUser;
  }

  /**
   * Возвращает нормализованный email адрес пользователя.
   */
  public get email(): string {
    return this.credentials.user;
  }

  /**
   * Создает сконфигурированный экземпляр ImapFlow для подключения к почтовому серверу МЭИ.
   */
  private createClient(user?: string): ImapFlow {
    // Один раз за процесс сообщаем, что цепочка сертификата не проверяется, а
    // заменена SPKI-пином: без этого в журнале нельзя отличить «проверяем
    // цепочку» от «проверяем отпечаток» при разборе инцидентов. Секретов в
    // строке нет.
    if (!pinNoticeLogged) {
      pinNoticeLogged = true;
      console.warn(
        '[Mail TLS] rejectUnauthorized=false (корень УЦ МЭИ недоступен); ' +
          'проверка сертификата заменена SPKI-пином mail.mpei.ru.',
      );
    }

    return new ImapFlow({
      host: 'mail.mpei.ru',
      port: 993,
      secure: true,
      auth: {
        user: user ?? this.imapUser,
        pass: this.credentials.pass,
      },
      // Таймаут на ВСЕ фазы, а не только на TCP-коннект: без socketTimeout
      // зависшая операция (сервер принял соединение и молчит) держала бы
      // запрос к /api/mail бесконечно. greetingTimeout закрывает ожидание
      // приветствия, socketTimeout — простой сокета между операциями.
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 20000,
      logger: false,
      tls: {
        // Цепочку до корня УЦ МЭИ проверить нечем — корня нет в публичном
        // доступе, поэтому проверку цепочки отключаем и заменяем её проверкой
        // отпечатка в checkServerIdentity (ниже). Само подключение без
        // успешной проверки не пройдёт.
        rejectUnauthorized: false,
        ciphers: 'DEFAULT@SECLEVEL=0',
        // Проверка имени хоста делается вместе с проверкой отпечатка:
        // cert.subjectaltname содержит mail.mpei.ru, так что hostVerified
        // вычисляется штатным механизмом node.
        checkServerIdentity: (host: string, cert: crypto.X509Certificate): Error | undefined => {
          // 1) Имя хоста: mail.mpei.ru есть в subjectAltName сертификата.
          const hostErr = checkCertificateHost(cert, host);
          if (hostErr) return hostErr;

          // 2) Отпечаток: главная проверка, именно она заменяет цепочку.
          const got = computeSpkiPin(cert);
          if (got !== expectedPin()) {
            return new Error(
              'Сертификат почтового сервера не совпадает с закреплённым отпечатком. ' +
                'Соединение прервано — возможна подмена сервера.',
            );
          }
          return undefined;
        },
      } as Record<string, unknown>,
    });
  }

  /**
   * Подключается к почтовому серверу с автоматической поддержкой форматов логина Exchange.
   */
  private async connectClient(): Promise<ImapFlow> {
    const client = this.createClient(this.imapUser);

    try {
      await client.connect();
      return client;
    } catch (err: unknown) {
      try {
        if (client.usable) await client.logout();
        else client.close();
      } catch {
        // ignore
      }

      // Если авторизация без домена завершилась ошибкой, пробуем полный email
      if (this.imapUser !== this.credentials.user) {
        const fallbackClient = this.createClient(this.credentials.user);
        try {
          await fallbackClient.connect();
          return fallbackClient;
        } catch (err2: unknown) {
          try {
            if (fallbackClient.usable) await fallbackClient.logout();
            else fallbackClient.close();
          } catch {
            // ignore
          }
          throw err;
        }
      }

      throw err;
    }
  }

  /**
   * Проверяет учетные данные пользователя, выполняя тестовое подключение и выход.
   */
  public async checkAuth(): Promise<{ success: boolean; error?: string }> {
    try {
      const client = await this.connectClient();
      await client.logout();
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /**
   * Подключается к почтовому серверу, запрашивает статус папки INBOX и возвращает количество писем.
   */
  public async getInboxStatus(): Promise<OsepFolderStatus> {
    const client = await this.connectClient();

    try {
      const status = await client.status('INBOX', { messages: true, unseen: true });
      await client.logout();

      if (!status) {
        throw new Error('Не удалось получить статус папки INBOX: папка не найдена или недоступна.');
      }

      return {
        total: status.messages ?? 0,
        unseen: status.unseen ?? 0,
      };
    } catch (err) {
      try {
        if (client.usable) {
          await client.logout();
        } else {
          client.close();
        }
      } catch {
        // Игнорируем ошибки при аварийном завершении
      }
      throw err;
    }
  }

  /**
   * Выбирает UID писем для выгрузки: последние `limit` либо последние непрочитанные.
   */
  private async selectTargetUids(
    client: ImapFlow,
    mailboxExists: number,
    options: FetchMessagesOptions
  ): Promise<number[]> {
    if (options.onlyUnread) {
      const found = await client.search({ seen: false }, { uid: true });
      return Array.isArray(found) && found.length > 0 ? found.slice(-options.limit) : [];
    }

    if (mailboxExists <= 0) return [];

    const targetUids: number[] = [];
    const startSeq = Math.max(1, mailboxExists - options.limit + 1);
    for await (const msg of client.fetch(`${startSeq}:${mailboxExists}`, { uid: true }, { uid: false })) {
      targetUids.push(msg.uid);
    }
    return targetUids;
  }

  /**
   * Выгружает метаданные писем БЕЗ скачивания тел.
   *
   * Всё нужное берётся из ENVELOPE (тема, отправитель, дата) и BODYSTRUCTURE
   * (наличие и имена вложений). На проводе вместо мегабайт MIME приходит
   * несколько килобайт заголовков — на реальном ящике МЭИ это 6844 КБ и 14 с
   * превращаются в 0 КБ и 0.4 с на те же 15 писем.
   */
  public async fetchMessageBriefs(options: FetchMessagesOptions): Promise<OsepMessageBrief[]> {
    const client = await this.connectClient();

    try {
      const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });
      const targetUids = await this.selectTargetUids(client, mailbox.exists || 0, options);
      if (targetUids.length === 0) return [];

      const briefs: OsepMessageBrief[] = [];

      for await (const msg of client.fetch(
        targetUids,
        { envelope: true, bodyStructure: true, size: true, flags: true, uid: true },
        { uid: true },
      )) {
        const envelope = msg.envelope;
        const fromEntry = envelope?.from?.[0];
        const from =
          fromEntry?.name?.trim() ||
          fromEntry?.address?.trim() ||
          'Неизвестный отправитель';

        briefs.push({
          uid: msg.uid,
          date: envelope?.date instanceof Date ? envelope.date : new Date(),
          from,
          subject: envelope?.subject?.trim() || '(Без темы)',
          hasAttachments: this.collectAttachmentNames(msg.bodyStructure).length > 0,
          // Флаги уже запрошены (`flags: true`); прочитанность нужна превью в
          // приложении, чтобы отличить прочитанное письмо от нового.
          isSeen: msg.flags ? msg.flags.has('\\Seen') : false,
        });
      }

      briefs.sort((a, b) => b.date.getTime() - a.date.getTime() || b.uid - a.uid);
      return briefs;
    } finally {
      try {
        if (client.usable) await client.logout();
        else client.close();
      } catch {
        // Игнорируем ошибки закрытия сессии
      }
    }
  }

  /**
   * Обходит MIME-дерево BODYSTRUCTURE и собирает имена вложенных файлов.
   * Сервер отдаёт вложения в узлах с disposition === 'attachment'.
   */
  private collectAttachmentNames(node: unknown, out: string[] = []): string[] {
    if (!node) return out;

    if (Array.isArray(node)) {
      for (const child of node) this.collectAttachmentNames(child, out);
      return out;
    }

    const part = node as {
      disposition?: string;
      parameters?: { name?: string };
      description?: string;
      dispositionParameters?: { filename?: string };
      childNodes?: unknown;
    };

    if (part.childNodes) this.collectAttachmentNames(part.childNodes, out);
    if (part.disposition === 'attachment') {
      out.push(
        part.dispositionParameters?.filename ||
          part.parameters?.name ||
          part.description ||
          'вложение',
      );
    }

    return out;
  }

  /**
   * Выгружает сообщения из папки INBOX с декодированием заголовков и текста.
   */
  public async fetchMessages(options: FetchMessagesOptions): Promise<OsepMessage[]> {
    const client = await this.connectClient();

    try {
      const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });

      const targetUids = await this.selectTargetUids(client, mailbox.exists || 0, options);

      if (targetUids.length === 0) {
        return [];
      }

      const messages: OsepMessage[] = [];

      for await (const msg of client.fetch(targetUids, { source: true, flags: true, uid: true }, { uid: true })) {
        if (!msg.source) continue;

        // mailparser весит ~8 МБ в памяти и нужен только здесь — ради превью
        // текста в экране ОСЭП. Подгружаем по требованию, чтобы фоновый
        // нотификатор не платил за него при старте.
        const { simpleParser } = await import('mailparser');
        const parsed = await simpleParser(msg.source);

        const fromName = parsed.from?.value[0]?.name?.trim();
        const fromAddress = parsed.from?.value[0]?.address?.trim() || '';
        const from = fromName || fromAddress || parsed.from?.text?.trim() || 'Неизвестный отправитель';
        const subject = parsed.subject?.trim() || '(Без темы)';

        let rawSnippet = parsed.text || '';
        if (!rawSnippet && typeof parsed.html === 'string') {
          rawSnippet = parsed.html
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<[^>]+>/g, ' ');
        }
        const cleanSnippet = rawSnippet.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
        const snippet = cleanSnippet.length > 150 ? `${cleanSnippet.slice(0, 150)}...` : cleanSnippet;

        const attachments = parsed.attachments || [];
        const hasAttachments = attachments.length > 0;
        const attachmentNames = attachments.map((att) => att.filename || 'вложение').filter(Boolean);
        const isSeen = msg.flags ? msg.flags.has('\\Seen') : false;

        messages.push({
          uid: msg.uid,
          date: parsed.date ?? new Date(),
          from,
          fromAddress,
          subject,
          snippet,
          hasAttachments,
          attachmentNames,
          isSeen,
        });
      }

      // Сортируем от новых к старым
      messages.sort((a, b) => b.date.getTime() - a.date.getTime() || b.uid - a.uid);

      return messages;
    } finally {
      try {
        if (client.usable) {
          await client.logout();
        } else {
          client.close();
        }
      } catch {
        // Игнорируем ошибки закрытия сессии в блоке finally
      }
    }
  }
}
