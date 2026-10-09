import { ImapFlow } from 'imapflow';
import type {
  OsepCredentials,
  OsepFolderStatus,
  OsepMessage,
  OsepMessageBrief,
  FetchMessagesOptions,
} from './types.js';

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
    return new ImapFlow({
      host: 'mail.mpei.ru',
      port: 993,
      secure: true,
      auth: {
        user: user ?? this.imapUser,
        pass: this.credentials.pass,
      },
      connectionTimeout: 10000,
      logger: false,
      tls: {
        rejectUnauthorized: false,
        // Почтовый сервер МЭИ (Exchange) требует совместимый набор шифров TLSv1.2 и использует корпоративный сертификат
        ciphers: 'DEFAULT@SECLEVEL=0',
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
