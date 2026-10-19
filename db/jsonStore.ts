import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'db', 'data');

/** В базе лежат зашифрованные креды и живые cookie-сессии — доступ только владельцу. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function storageErrorLabel(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Простое хранилище "ключ -> запись" в JSON-файле с атомарной записью.
 */
export class JsonStore<T> {
  private readonly file: string;
  private cache: Record<string, T> | null = null;
  private permissionsHardened = false;

  constructor(fileName: string) {
    this.file = path.join(DATA_DIR, fileName);
  }

  /**
   * Приводит файл к 0600.
   *
   * Каталог и файл раньше создавались с правами по умолчанию (0644 при umask
   * 022), то есть любой локальный пользователь, бэкап-агент или tar дистрива
   * мог прочитать креды всех студентов. Режим выставляется и на создании, и
   * принудительно при каждой записи — чтобы починить и уже существующие файлы.
   */
  private hardenPermissions(): void {
    try {
      fs.chmodSync(DATA_DIR, DIR_MODE);
    } catch {
      // нет прав — не критично, файл всё равно закрывается ниже
    }
    try {
      fs.chmodSync(this.file, FILE_MODE);
    } catch {
      // файл ещё не существует
    }
  }

  all(): Record<string, T> {
    if (this.cache) return this.cache;
    if (!this.permissionsHardened) {
      this.hardenPermissions();
      this.permissionsHardened = true;
    }
    try {
      this.cache = fs.existsSync(this.file)
        ? (JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, T>)
        : {};
    } catch (e) {
      console.error(`[JsonStore] Не удалось прочитать хранилище (${storageErrorLabel(e)}).`);
      this.cache = {};
    }
    return this.cache;
  }

  values(): T[] {
    return Object.values(this.all());
  }

  get(key: string | number): T | undefined {
    return this.all()[String(key)];
  }

  set(key: string | number, value: T): void {
    this.all()[String(key)] = value;
    this.save();
  }

  delete(key: string | number): T | undefined {
    const removed = this.remove(key);
    if (removed !== undefined) this.save();
    return removed;
  }

  /**
   * Кладёт значение в кэш без записи на диск. Сброс — через save().
   * Нужен там, где за один проход накапливается много изменений одного файла.
   */
  stage(key: string | number, value: T): void {
    this.all()[String(key)] = value;
  }

  /**
   * Удаляет ключ из кэша без записи на диск. Сброс — через save().
   */
  remove(key: string | number): T | undefined {
    const existing = this.all()[String(key)];
    if (existing !== undefined) {
      delete this.all()[String(key)];
    }
    return existing;
  }

  save(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: DIR_MODE });
      const tmp = `${this.file}.tmp`;
      // mode действует только при создании, поэтому tmp-файл создаётся с
      // правильными правами явно, а существующий — ужёстчается после записи.
      fs.writeFileSync(tmp, JSON.stringify(this.all(), null, 2), { encoding: 'utf-8', mode: FILE_MODE });
      fs.renameSync(tmp, this.file);
      this.hardenPermissions();
    } catch (e) {
      console.error(`[JsonStore] Не удалось сохранить хранилище (${storageErrorLabel(e)}).`);
    }
  }
}

/**
 * Хранилище структурированного документа: один JSON-файл с произвольной
 * верхнеуровневой формой.
 *
 * Нужно там, где файл — не плоская карта «ключ → запись», а документ с
 * несколькими разделами: у users.json рядом с записями лежат два индекса, и
 * их надо писать в одном файле и одной атомарной операцией. Иначе индекс
 * мог бы оказаться на диске без записей (или наоборот) — то есть база была бы
 * в состоянии, из которого нельзя восстановиться.
 *
 * Файл не перезаписывается, пока не вызван save(): те же правила, что у
 * JsonStore, плюс stage/remove — чтобы за один проход (например, регистрация
 * с обновлением обоих индексов) не писать файл трижды.
 */
export class JsonDocument<T extends object> {
  private readonly file: string;
  private cache: T | null = null;
  private permissionsHardened = false;

  constructor(fileName: string) {
    this.file = path.join(DATA_DIR, fileName);
  }

  private hardenPermissions(): void {
    try {
      fs.chmodSync(DATA_DIR, DIR_MODE);
    } catch {
      // нет прав — не критично, файл всё равно закрывается ниже
    }
    try {
      fs.chmodSync(this.file, FILE_MODE);
    } catch {
      // файла ещё нет
    }
  }

  read(): T {
    if (this.cache) return this.cache;

    if (!this.permissionsHardened) {
      this.hardenPermissions();
      this.permissionsHardened = true;
    }

    try {
      this.cache = fs.existsSync(this.file)
        ? (JSON.parse(fs.readFileSync(this.file, 'utf-8')) as T)
        : ({} as T);
    } catch (e) {
      console.error(`[JsonDocument] Не удалось прочитать документ (${storageErrorLabel(e)}).`);
      this.cache = {} as T;
    }

    return this.cache;
  }

  stage(doc: T): void {
    this.cache = doc;
  }

  save(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: DIR_MODE });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.read(), null, 2), { encoding: 'utf-8', mode: FILE_MODE });
      fs.renameSync(tmp, this.file);
      this.hardenPermissions();
    } catch (e) {
      console.error(`[JsonDocument] Не удалось сохранить документ (${storageErrorLabel(e)}).`);
    }
  }

  /** Полностью перезаписывает файл новым документом (сброс базы). */
  replace(doc: T): void {
    this.cache = doc;
    this.save();
  }

  /** Удаляет файл и сбрасывает кэш — используется при сбросе базы. */
  drop(): void {
    this.cache = null;
    try {
      fs.rmSync(this.file, { force: true });
    } catch (e) {
      console.error(`[JsonDocument] Не удалось удалить документ (${storageErrorLabel(e)}).`);
    }
  }

  /** Абсолютный путь к файлу — нужен тестам и скриптам сброса. */
  get path(): string {
    return this.file;
  }
}
