import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');

/**
 * Простое хранилище "ключ -> запись" в JSON-файле с атомарной записью.
 */
export class JsonStore<T> {
  private readonly file: string;
  private cache: Record<string, T> | null = null;

  constructor(fileName: string) {
    this.file = path.join(DATA_DIR, fileName);
  }

  all(): Record<string, T> {
    if (this.cache) return this.cache;
    try {
      this.cache = fs.existsSync(this.file)
        ? (JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, T>)
        : {};
    } catch (e) {
      console.error(`[JsonStore] Не удалось прочитать ${this.file}:`, e);
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
    const existing = this.all()[String(key)];
    if (existing !== undefined) {
      delete this.all()[String(key)];
      this.save();
    }
    return existing;
  }

  save(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.all(), null, 2), 'utf-8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error(`[JsonStore] Не удалось сохранить ${this.file}:`, e);
    }
  }
}
