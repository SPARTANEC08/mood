/**
 * Фоновые админские задачи: рассылка и принудительный прогон нотификатора.
 *
 * Обе длятся минуты, поэтому HTTP-запрос не ждёт их окончания: создаётся job,
 * клиент опрашивает прогресс. Хранилище — память процесса: после рестарта
 * задача считается прерванной, и её можно запустить заново. Долговечный
 * журнал для этого не нужен — результат всё равно виден по доставкам.
 */

import { randomUUID } from 'node:crypto';

export type AdminJobKind = 'broadcast' | 'notifier';
export type AdminJobStatus = 'running' | 'done' | 'failed';

export interface AdminJob {
  id: string;
  kind: AdminJobKind;
  status: AdminJobStatus;
  startedAt: string;
  finishedAt?: string;
  total: number;
  done: number;
  /** Счётчики по каналам/этапам: push, telegram, feed, failed… */
  progress: Record<string, number>;
  message?: string;
  error?: string;
}

const MAX_FINISHED_JOBS = 20;
const jobs = new Map<string, AdminJob>();

export function createJob(kind: AdminJobKind, total: number): AdminJob {
  const job: AdminJob = {
    id: randomUUID(),
    kind,
    status: 'running',
    startedAt: new Date().toISOString(),
    total: Math.max(0, total),
    done: 0,
    progress: {},
  };

  jobs.set(job.id, job);
  trim();
  return job;
}

export function getJob(id: string): AdminJob | null {
  return jobs.get(id) ?? null;
}

/** Идущая задача того же типа: второй параллельный прогон не нужен. */
export function runningJob(kind: AdminJobKind): AdminJob | null {
  for (const job of jobs.values()) {
    if (job.kind === kind && job.status === 'running') return job;
  }
  return null;
}

export function bumpJob(
  id: string,
  patch: { done?: number; progress?: Record<string, number>; message?: string },
): void {
  const job = jobs.get(id);
  if (!job) return;

  if (typeof patch.done === 'number') job.done = patch.done;
  if (patch.progress) {
    for (const [key, value] of Object.entries(patch.progress)) {
      job.progress[key] = (job.progress[key] ?? 0) + value;
    }
  }
  if (patch.message) job.message = patch.message;
}

export function finishJob(id: string, error?: string): void {
  const job = jobs.get(id);
  if (!job) return;

  job.status = error ? 'failed' : 'done';
  job.finishedAt = new Date().toISOString();
  if (error) job.error = error;
  if (!error) job.done = job.total;
}

/** Оставляет только последние завершённые задачи, чтобы память не росла. */
function trim(): void {
  const finished = [...jobs.values()]
    .filter((job) => job.status !== 'running')
    .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''));

  for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
    jobs.delete(job.id);
  }
}
