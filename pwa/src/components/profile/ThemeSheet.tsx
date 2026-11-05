/**
 * Нижний лист «Темы»: витрина официальных и пользовательских тем + конструктор.
 *
 * Логика повторяет калькулятор и центр уведомлений: тот же BottomSheet, тот же
 * фиксированный скролл и закреплённый footer. Внутри две вкладки:
 *   - «Все темы» — сетка квадратных плиток с живым мини-макетом;
 *   - «Создать свою» — три ползунка оттенка, предпросмотр и публикация.
 *
 * Автор темы не показывается нигде: сервер отдаёт только `mine`, а список
 * сообщества приходит без идентификаторов пользователей.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Check, Lightbulb, Plus, Trash2, X } from 'lucide-react';

import { BottomSheet, EmptyState, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { haptic, openLink } from '@/lib/env';
import { OFFICIAL_THEMES } from '@/lib/officialThemes';
import { getSelectedTheme, useThemePreset } from '@/lib/theme';
import {
  deriveThemeTokens,
  hasVariants,
  variantKeys,
  type ThemeDefinition,
  type ThemeVariant,
  type ThemeVariantKey,
} from '@/lib/themeColors';
import { readThemesCache, sanitizeTheme, writeThemesCache } from '@/lib/themes';

type Tab = 'all' | 'create';
type Filter = 'all' | 'official' | 'mine';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'official', label: 'Официальные' },
  { id: 'mine', label: 'Мои' },
];

const CACHE_TTL_MS = 5 * 60 * 1000;

const SUPPORT_URL = 'https://t.me/mood_mpei_sup';

const DEFAULT_VARIANT: ThemeVariant = {
  backgroundHue: 255,
  surfaceHue: 255,
  accentHue: 255,
};

/** Текущий вариант текущей темы — с него начинается конструктор. */
function initialVariants(theme: ThemeDefinition, preferred: ThemeVariantKey): Partial<Record<ThemeVariantKey, ThemeVariant>> {
  const key = theme.variants[preferred] ? preferred : (variantKeys(theme)[0] ?? 'dark');
  const source = theme.variants[key] ?? DEFAULT_VARIANT;
  return { [key]: { ...source } };
}

export function ThemeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { theme, applyTheme, effective } = useThemePreset();

  const [tab, setTab] = useState<Tab>('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [community, setCommunity] = useState<ThemeDefinition[] | null>(null);
  const [selected, setSelected] = useState<ThemeDefinition>(() => getSelectedTheme());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    const cache = readThemesCache();
    if (cache) setCommunity(cache.items);

    if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await api.themes();
      const items = response.items
        .map((item) => sanitizeTheme({ ...item, official: false }))
        .filter((item): item is ThemeDefinition => item !== null);

      setCommunity(items);
      writeThemesCache(items);
    } catch {
      if (!cache) {
        setError('Не удалось загрузить темы сообщества. Официальные темы доступны.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // При каждом открытии показываем актуальную выбранную тему и обновляем кэш.
  useEffect(() => {
    if (!open) return;
    setSelected(getSelectedTheme());
    void load();
  }, [open, load]);

  const mineLocal = theme.local ? [theme] : [];
  const officialThemes = OFFICIAL_THEMES;
  const communityThemes = community ?? [];

  const mineThemes = [
    ...mineLocal,
    ...communityThemes.filter((item) => item.mine && item.id !== theme.id),
  ];

  const allThemes = [
    ...officialThemes,
    ...mineLocal.filter((item) => !officialThemes.some((official) => official.id === item.id)),
    ...communityThemes,
  ];

  const visible =
    filter === 'official' ? officialThemes : filter === 'mine' ? mineThemes : allThemes;

  const selectedId = selected.id;
  const canApply = selectedId !== theme.id;

  async function removeTheme(id: string): Promise<void> {
    if (!window.confirm('Удалить тему? Она исчезнет из общего списка.')) return;

    try {
      await api.deleteTheme(id);
      setCommunity((previous) => {
        const next = (previous ?? []).filter((item) => item.id !== id);
        writeThemesCache(next);
        return next;
      });
      if (selected.id === id) setSelected(getSelectedTheme());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить тему.');
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Темы"
      closeLabel="Закрыть"
      height="min(780px, 92dvh)"
      footer={
        tab === 'all' ? (
          <button
            type="button"
            disabled={!canApply}
            onClick={() => {
              haptic('medium');
              applyTheme(selected);
              onClose();
            }}
            className="pressable w-full rounded-[14px] py-3 text-[16px] font-semibold active:pressable-active disabled:opacity-40"
            style={{
              background: canApply ? 'var(--accent)' : 'var(--surface-grouped)',
              color: canApply ? 'var(--accent-text)' : 'var(--text-tertiary)',
            }}
          >
            Применить
          </button>
        ) : undefined
      }
    >
      <div className="mb-3 flex gap-1 rounded-[12px] p-1" style={{ background: 'var(--surface-grouped)' }} role="tablist">
        {([
          { id: 'all' as const, label: 'Все темы' },
          { id: 'create' as const, label: 'Создать свою' },
        ]).map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => {
              haptic('light');
              setTab(entry.id);
            }}
            className="pressable flex-1 rounded-[9px] py-2 text-[13px] font-semibold active:pressable-active"
            style={{
              background: tab === entry.id ? 'var(--surface)' : 'transparent',
              color: tab === entry.id ? 'var(--accent)' : 'var(--text-secondary)',
              boxShadow: tab === entry.id ? 'var(--shadow-card)' : 'none',
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <SupportNote />

      {error ? (
        <div
          className="mb-3 flex items-center justify-between gap-3 rounded-[12px] px-3 py-2"
          style={{ background: 'rgba(255,59,48,0.1)' }}
        >
          <p className="text-[12px] leading-snug" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
          <button
            type="button"
            onClick={() => void load(true)}
            className="pressable shrink-0 text-[12px] font-semibold"
            style={{ color: 'var(--danger)' }}
          >
            Повторить
          </button>
        </div>
      ) : null}

      {tab === 'all' ? (
        <AllThemes
          filter={filter}
          setFilter={setFilter}
          visible={visible}
          loading={loading && community === null}
          community={community}
          currentId={theme.id}
          selectedId={selectedId}
          previewVariant={effective}
          onSelect={(next) => {
            haptic('light');
            setSelected(next);
          }}
          onDelete={(id) => void removeTheme(id)}
          showMineActions={filter === 'mine'}
        />
      ) : (
        <ThemeConstructor
          source={theme}
          preferredVariant={effective}
          onPublished={(published) => {
            setCommunity((previous) => {
              const next = [published, ...(previous ?? []).filter((item) => item.id !== published.id)];
              writeThemesCache(next);
              return next;
            });
            applyTheme(published);
            onClose();
          }}
        />
      )}
    </BottomSheet>
  );
}

/* ── витрина ──────────────────────────────────────────────────────────────── */

function SupportNote() {
  return (
    <div
      className="mb-3 flex items-start gap-2 rounded-[14px] px-3 py-2.5"
      style={{ background: 'var(--surface-grouped)' }}
    >
      <Lightbulb size={15} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
      <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        Не получается подобрать?{' '}
        <button
          type="button"
          onClick={() => {
            haptic('light');
            openLink(SUPPORT_URL);
          }}
          className="font-semibold"
          style={{ color: 'var(--accent)' }}
        >
          Предложите тему в поддержке
        </button>{' '}
        — мы добавим её сами.
      </p>
    </div>
  );
}

function AllThemes({
  filter,
  setFilter,
  visible,
  loading,
  community,
  currentId,
  selectedId,
  previewVariant,
  onSelect,
  onDelete,
  showMineActions,
}: {
  filter: Filter;
  setFilter: (filter: Filter) => void;
  visible: ThemeDefinition[];
  loading: boolean;
  community: ThemeDefinition[] | null;
  currentId: string;
  selectedId: string;
  previewVariant: ThemeVariantKey;
  onSelect: (theme: ThemeDefinition) => void;
  onDelete: (id: string) => void;
  showMineActions: boolean;
}) {
  return (
    <>
      <div className="scroll-hidden -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {FILTERS.map((entry) => {
          const active = filter === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                haptic('light');
                setFilter(entry.id);
              }}
              className="pressable shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold active:pressable-active"
              style={{
                background: active ? 'var(--accent-soft)' : 'var(--surface-grouped)',
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2.5">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="aspect-square rounded-[16px]" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          title={filter === 'mine' ? 'У вас пока нет тем' : 'Пока нет тем'}
          description={
            filter === 'mine'
              ? 'Создайте свою во вкладке «Создать свою» — она появится здесь.'
              : community === null
                ? 'Темы сообщества не загрузились, но официальные доступны.'
                : 'Темы сообщества появятся здесь после публикации.'
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-2.5 pb-2" role="radiogroup" aria-label="Темы оформления">
          {visible.map((theme) => (
            <ThemeTile
              key={theme.id}
              theme={theme}
              previewVariant={previewVariant}
              active={theme.id === currentId}
              selected={theme.id === selectedId}
              canDelete={showMineActions && theme.mine === true && !theme.official}
              onSelect={() => onSelect(theme)}
              onDelete={() => onDelete(theme.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ThemeTile({
  theme,
  previewVariant,
  active,
  selected,
  canDelete,
  onSelect,
  onDelete,
}: {
  theme: ThemeDefinition;
  previewVariant: ThemeVariantKey;
  active: boolean;
  selected: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const variant = theme.variants[previewVariant]
    ? previewVariant
    : (variantKeys(theme)[0] ?? 'dark');
  const ring = selected ? 'var(--accent)' : active ? 'var(--text-tertiary)' : 'transparent';

  return (
    <div className="relative">
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={theme.name}
        onClick={onSelect}
        className="pressable relative block aspect-square w-full overflow-hidden rounded-[16px] text-left active:pressable-active"
        style={{
          boxShadow: `inset 0 0 0 ${selected || active ? 2 : 1}px ${ring === 'transparent' ? 'var(--separator-soft)' : ring}`,
        }}
      >
        <ThemePreview theme={theme} variant={variant} className="absolute inset-0" />

        <span
          className="absolute inset-x-0 bottom-0 block px-2.5 pb-2 pt-7 text-[12px] font-semibold leading-tight text-white"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.72), rgba(0,0,0,0))' }}
        >
          {theme.name}
        </span>

        {active ? (
          <span
            className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full"
            style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}
            aria-hidden
          >
            <Check size={12} strokeWidth={3} />
          </span>
        ) : null}
      </button>

      {canDelete ? (
        <button
          type="button"
          aria-label={`Удалить тему ${theme.name}`}
          onClick={onDelete}
          className="pressable absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full active:pressable-active"
          style={{ background: 'rgba(0,0,0,0.45)', color: '#fff' }}
        >
          <Trash2 size={12} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/* ── конструктор ──────────────────────────────────────────────────────────── */

function ThemeConstructor({
  source,
  preferredVariant,
  onPublished,
}: {
  source: ThemeDefinition;
  preferredVariant: ThemeVariantKey;
  onPublished: (theme: ThemeDefinition) => void;
}) {
  const [name, setName] = useState('');
  const [variants, setVariants] = useState<Partial<Record<ThemeVariantKey, ThemeVariant>>>(
    () => initialVariants(source, preferredVariant),
  );
  const [activeVariant, setActiveVariant] = useState<ThemeVariantKey>(() => {
    const keys = variantKeys({ id: 'x', name: 'x', variants: initialVariants(source, preferredVariant) });
    return keys[0] ?? 'dark';
  });
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = variants[activeVariant];
  const canPublish = name.trim().length > 0 && hasVariants({ id: 'preview', name, variants }) && !publishing;

  const addVariant = (key: ThemeVariantKey): void => {
    if (variants[key]) {
      setActiveVariant(key);
      return;
    }

    const base = active ?? DEFAULT_VARIANT;
    setVariants((previous) => ({ ...previous, [key]: { ...base } }));
    setActiveVariant(key);
    haptic('light');
  };

  const removeVariant = (key: ThemeVariantKey): void => {
    const keys = (['light', 'dark'] as const).filter((item) => variants[item]);
    if (keys.length <= 1) return;

    const next = { ...variants };
    delete next[key];
    setVariants(next);
    setActiveVariant(key === 'light' ? 'dark' : 'light');
    haptic('light');
  };

  const updateHue = (field: keyof ThemeVariant, value: number): void => {
    setVariants((previous) => {
      const current = previous[activeVariant] ?? DEFAULT_VARIANT;
      return {
        ...previous,
        [activeVariant]: { ...current, [field]: Math.round(Math.max(0, Math.min(359, value))) },
      };
    });
  };

  const previewTheme: ThemeDefinition = {
    id: 'preview',
    name: name.trim() || 'Ваша тема',
    variants,
  };

  return (
    <div className="space-y-4 pb-2">
      <label className="block">
        <span className="mb-1.5 block px-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
          Название
        </span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={24}
          placeholder="Например, «Закат»"
          className="w-full rounded-[12px] px-3.5 py-2.5 text-[15px] outline-none"
          style={{ background: 'var(--surface-grouped)', color: 'var(--text-primary)' }}
        />
      </label>

      <div>
        <span className="mb-1.5 block px-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
          Версии темы
        </span>
        <div className="flex gap-2">
          {(['dark', 'light'] as const).map((key) => {
            const exists = Boolean(variants[key]);
            const activeChip = activeVariant === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => addVariant(key)}
                className="pressable flex flex-1 items-center justify-center gap-1.5 rounded-[12px] py-2 text-[13px] font-semibold active:pressable-active"
                style={{
                  background: activeChip ? 'var(--accent)' : 'var(--surface-grouped)',
                  color: activeChip ? 'var(--accent-text)' : exists ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                {exists ? <Check size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
                {key === 'dark' ? 'Тёмная' : 'Светлая'}
              </button>
            );
          })}
        </div>
        {Object.keys(variants).length > 1 ? (
          <button
            type="button"
            onClick={() => removeVariant(activeVariant)}
            className="pressable mt-2 inline-flex items-center gap-1 text-[11px] font-medium active:pressable-active"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <X size={12} aria-hidden />
            Убрать активную версию
          </button>
        ) : (
          <p className="mt-2 text-[11px] leading-snug" style={{ color: 'var(--text-tertiary)' }}>
            Вторая версия необязательна. Если её нет, переключатель светлой и тёмной темы
            будет заблокирован.
          </p>
        )}
      </div>

      {active ? (
        <div
          className="space-y-3 rounded-[16px] px-3.5 py-3.5"
          style={{ background: 'var(--surface)', border: '1px solid var(--separator-soft)' }}
        >
          <HueSlider label="Фон" value={active.backgroundHue} onChange={(value) => updateHue('backgroundHue', value)} />
          <HueSlider label="Карточки" value={active.surfaceHue} onChange={(value) => updateHue('surfaceHue', value)} />
          <HueSlider label="Акцент" value={active.accentHue} onChange={(value) => updateHue('accentHue', value)} />
        </div>
      ) : null}

      <div>
        <span className="mb-1.5 block px-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
          Предпросмотр
        </span>
        <div
          className="rounded-[20px] p-4"
          style={{ background: 'var(--surface-grouped)' }}
        >
          <ThemePreview
            theme={previewTheme}
            variant={activeVariant}
            className="mx-auto aspect-square w-full max-w-[240px] rounded-[18px] shadow-lg"
          />
        </div>
      </div>

      {error ? (
        <p className="rounded-[12px] px-3 py-2 text-[12px] leading-snug" style={{ background: 'rgba(255,59,48,0.1)', color: 'var(--danger)' }}>
          {error}
        </p>
      ) : null}

      <p className="px-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
        Публикуется сразу. Не больше 3 тем в сутки. Автор не показывается.
      </p>

      <button
        type="button"
        disabled={!canPublish}
        onClick={() => {
          if (!canPublish) return;
          haptic('medium');
          setPublishing(true);
          setError(null);

          void api
            .createTheme({ name: name.trim(), variants })
            .then((result) => {
              const published =
                sanitizeTheme({ ...result.theme, official: false }) ?? {
                  ...result.theme,
                  official: false,
                };
              onPublished(published);
            })
            .catch((err: unknown) => {
              setError(err instanceof Error ? err.message : 'Не удалось опубликовать тему.');
            })
            .finally(() => setPublishing(false));
        }}
        className="pressable w-full rounded-[14px] py-3 text-[16px] font-semibold active:pressable-active disabled:opacity-40"
        style={{
          background: canPublish ? 'var(--accent)' : 'var(--surface-grouped)',
          color: canPublish ? 'var(--accent-text)' : 'var(--text-tertiary)',
        }}
      >
        {publishing ? 'Публикуем…' : 'Опубликовать'}
      </button>
    </div>
  );
}

/* ── ползунок оттенка ─────────────────────────────────────────────────────── */

function HueSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
          {value}°
        </span>
      </div>
      <div className="relative mt-1 h-8">
        <div
          className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full"
          style={{
            background:
              'linear-gradient(90deg, hsl(0 85% 55%), hsl(30 85% 55%), hsl(60 85% 55%), hsl(90 85% 45%), hsl(120 85% 40%), hsl(150 85% 40%), hsl(180 85% 40%), hsl(210 85% 50%), hsl(240 85% 60%), hsl(270 85% 60%), hsl(300 85% 55%), hsl(330 85% 55%), hsl(360 85% 55%))',
          }}
        />
        <input
          type="range"
          min={0}
          max={359}
          step={1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label={label}
          className="mood-hue-range absolute inset-0 h-8 w-full cursor-pointer"
        />
      </div>
    </div>
  );
}

/* ── мини-макет ───────────────────────────────────────────────────────────── */

/**
 * Квадратная миниатюра экрана: статус-строка, шапка, карточка, акцентная
 * кнопка и нижняя панель. Цвета берутся из тех же токенов, что и приложение,
 * поэтому плитка честно показывает, как тема выглядит.
 */
export function ThemePreview({
  theme,
  variant,
  className,
}: {
  theme: ThemeDefinition;
  variant: ThemeVariantKey;
  className?: string;
}) {
  const key = theme.variants[variant] ? variant : (variantKeys(theme)[0] ?? 'dark');
  const source = theme.variants[key] ?? DEFAULT_VARIANT;
  const tokens = deriveThemeTokens(source, key);

  const style: CSSProperties = {
    background: tokens.appBg,
    color: tokens.textPrimary,
  };

  return (
    <div className={className} style={style} aria-hidden>
      <div className="flex h-full flex-col p-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[7px] font-semibold tabular-nums" style={{ color: tokens.textSecondary }}>
            9:41
          </span>
          <span className="h-1 w-5 rounded-full" style={{ background: tokens.accent }} />
        </div>

        <div className="mt-2.5 space-y-1">
          <div className="h-1.5 w-12 rounded-full" style={{ background: tokens.textPrimary, opacity: 0.9 }} />
          <div className="h-1 w-16 rounded-full" style={{ background: tokens.textSecondary, opacity: 0.55 }} />
        </div>

        <div
          className="mt-2.5 flex-1 rounded-[8px] p-2"
          style={{ background: tokens.surface, boxShadow: `inset 0 0 0 1px ${tokens.separatorSoft}` }}
        >
          <div className="flex items-center gap-1">
            <span className="h-3 w-3 rounded-[3px]" style={{ background: tokens.accentSoft }} />
            <span className="h-1.5 w-10 rounded-full" style={{ background: tokens.textPrimary, opacity: 0.8 }} />
          </div>
          <div className="mt-1.5 space-y-1">
            <div className="h-1 w-full rounded-full" style={{ background: tokens.textSecondary, opacity: 0.5 }} />
            <div className="h-1 w-2/3 rounded-full" style={{ background: tokens.textSecondary, opacity: 0.5 }} />
          </div>
          <div className="mt-2 flex gap-1">
            <span className="h-3 flex-1 rounded-full" style={{ background: tokens.accent }} />
            <span className="h-3 w-6 rounded-full" style={{ background: tokens.surfaceGrouped }} />
          </div>
        </div>

        <div
          className="mt-2 flex items-center justify-around rounded-[7px] px-2 py-1.5"
          style={{ background: tokens.surface, boxShadow: `inset 0 0 0 1px ${tokens.separatorSoft}` }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: tokens.accent }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: tokens.textTertiary }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: tokens.textTertiary }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: tokens.textTertiary }} />
        </div>
      </div>
    </div>
  );
}
