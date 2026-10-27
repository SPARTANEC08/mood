/**
 * Поиск группы для гостевого входа.
 *
 * Подсказки приходят из ts.mpei.ru через сервер. Пока человек печатает, запрос
 * дебаунсится: иначе каждый символ «ИЭ-11-26» давал бы отдельный поход в МЭИ.
 * Выбранная группа хранится объектом, а не строкой: серверу нужен numeric id.
 */

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';

import { ApiError, api } from '@/lib/api';
import { haptic } from '@/lib/env';
import type { GuestGroup } from '@/types/api';

export function GuestGroupField({
  value,
  onChange,
  disabled = false,
}: {
  value: GuestGroup | null;
  onChange: (group: GuestGroup | null) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState(value?.label ?? '');
  const [items, setItems] = useState<GuestGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<number | null>(null);

  useEffect(() => {
    if (value) setQuery(value.label);
  }, [value]);

  useEffect(() => {
    if (!open) return;

    const term = query.trim();
    if (term.length < 2) {
      setItems([]);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);

      void api
        .guestGroups(term)
        .then((result) => {
          if (cancelled) return;
          setItems(result.items);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setItems([]);
          setError(err instanceof ApiError ? err.message : 'Не удалось найти группу.');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  useEffect(() => {
    return () => {
      if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
    };
  }, []);

  return (
    <div className="space-y-1.5">
      <label className="px-1 text-[12px] font-medium text-[var(--text-secondary)]" htmlFor="guest-group">
        Группа
      </label>

      <div className="relative">
        <Search
          size={16}
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
          style={{ color: 'var(--text-tertiary)' }}
        />

        <input
          id="guest-group"
          value={query}
          disabled={disabled}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Например, ИЭ-11-26"
          onFocus={() => setOpen(true)}
          onBlur={() => {
            blurTimer.current = window.setTimeout(() => setOpen(false), 150);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            if (value) onChange(null);
            setOpen(true);
          }}
          className="w-full rounded-[12px] border border-[var(--separator-soft)] bg-[var(--surface)] py-2.5 pl-9 pr-3 text-[15px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:opacity-50"
        />

        {open && query.trim().length >= 2 ? (
          <div
            className="mt-1 max-h-[240px] overflow-y-auto rounded-[12px] border p-1 shadow-lg"
            style={{ background: 'var(--surface)', borderColor: 'var(--separator-soft)' }}
          >
            {loading ? (
              <p className="px-3 py-2 text-[13px] text-[var(--text-tertiary)]">Ищем группу…</p>
            ) : error ? (
              <p className="px-3 py-2 text-[13px] text-[var(--danger)]">{error}</p>
            ) : items.length === 0 ? (
              <p className="px-3 py-2 text-[13px] text-[var(--text-tertiary)]">Группа не найдена.</p>
            ) : (
              items.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    haptic('light');
                    onChange(group);
                    setQuery(group.label);
                    setOpen(false);
                  }}
                  className="pressable w-full rounded-[9px] px-3 py-2 text-left active:pressable-active"
                  style={{ color: 'var(--text-primary)' }}
                >
                  <span className="block text-[14px] font-medium">{group.label}</span>
                  {group.description ? (
                    <span className="mt-0.5 block text-[11px] text-[var(--text-tertiary)]">
                      {group.description}
                    </span>
                  ) : null}
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
