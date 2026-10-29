import { useEffect, useState, type FormEvent } from 'react';

import { ScheduleApp } from '@/app/ScheduleApp';
import { GuestOnboarding } from '@/components/guest/GuestOnboarding';
import { InstallPrompt, shouldShowInstallPrompt } from '@/components/InstallPrompt';
import { IosInstallGuide, useShouldShowIosInstallGuide } from '@/components/IosInstallGuide';
import { DiagnosticsScreen } from '@/DiagnosticsScreen';
import { api } from '@/lib/api';
import { haptic, isIOS, openLink } from '@/lib/env';
import { LOGIN_DOCUMENTS, POLICY_LINK, PUSH_DOCUMENT } from './legal';
import type { LegalDocId } from './types/api';
import {
  AuthError,
  confirmTwoFactor,
  hasUsablePwaToken,
  isPwaTokenExpired,
  isTwoFactorRequired,
  loginWithPassword,
  clearGuestMode,
  clearPwaToken,
  getPwaToken,
  isGuestMode,
  setGuestMode,
  setPwaToken,
  SIGNED_OUT_EVENT,
  type PwaTokenResponse,
} from './auth';

/**
 * Корень приложения.
 *
 * Само приложение — это pwa/src/app/ScheduleApp.tsx: те же страницы, тот же
 * провайдер кэша. Здесь только входная дверь:
 *
 * 1. Токена ещё нет и человек открыл сайт в браузере — первый экран с
 *    предложением поставить приложение на домашний экран.
 * 2. Токена нет — вход по логину и паролю БАРС. Отдельного шага «регистрация»
 *    нет и не было нужды: запись заводится автоматически при первом входе, а
 *    вопрос «вы здесь впервые?» ничего не меняет — логин и пароль проверяются
 *    БАРС одинаково в обоих случаях.
 * 3. Есть токен — открываем приложение. Отдельная фаза «обмена кода» не нужна:
 *    вход в PWA самостоятельный, Telegram для него не требуется.
 *
 * Экран входа — нормальное состояние, а не авария: именно так выглядит первый
 * запуск на новом устройстве.
 */

type Phase = 'ready' | 'welcome' | 'guest';

/**
 * Сколько ждём код подтверждения, прежде чем вернуть человека к логину.
 *
 * Пять минут — с запасом: код от БАРС обычно приходит за минуту, но при
 * задержке оператора связи две-три минуты тоже нормальны.
 *
 * Почему это вообще нужно. Без предельного времени экран ввода кода висит
 * бесконечно: если СМС не пришла — например, БАРС ограничил частоту отправки,
 * о чём сервер знает, а человек нет, — единственный способ продолжить был
 * ждать. Именно это и выглядит как «вход на 40 минут»: человек смотрит на
 * пустое поле ввода кода, которого не придёт.
 */
const TWO_FA_WAIT_MS = 5 * 60 * 1000;

export default function App() {
  const [phase, setPhase] = useState<Phase>(() =>
    hasUsablePwaToken() ? 'ready' : 'welcome',
  );
  /** null — конфиг ещё грузится; false — рубильник регистрации закрыт. */
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);

  /**
   * Экран замеров включается адресом с ?debug=1.
   *
   * Он нужен для одного случая: замеры на десктопном Chrome показывают «всё
   * быстро», а на iPhone интерфейс лагает. Отличить «тормозит скрипт» от
   * «тормозит отрисовка» можно только на том устройстве, где тормозит, —
   * поэтому счётчики кадров и длинных задач считаются прямо в браузере.
   */
  const [debugOpen, setDebugOpen] = useState(
    () => new URLSearchParams(window.location.search).get('debug') === '1',
  );

  /**
   * Показывать ли первый экран с установкой.
   *
   * Проверка состояния (браузер, не standalone, не отказывался, не dev-домен)
   * живёт в компоненте, решение — здесь: экран перекрывает всё остальное,
   * поэтому он и должен быть первым в цепочке условий ниже.
   */
  const [installOpen, setInstallOpen] = useState(() => shouldShowInstallPrompt());

  /**
   * iOS-гайд установки. Показывается ТОЛЬКО на iOS в браузере и при каждой
   * загрузке; на Android и десктопе всегда false, поэтому их поведение не
   * меняется (см. IosInstallGuide).
   */
  const iosGuide = useShouldShowIosInstallGuide();

  /** Идёт ввод кода 2FA — в этот момент гайд не перебиваем. */
  const [twoFactorActive, setTwoFactorActive] = useState(false);

  /**
   * Возврат подсказки после установки.
   *
   * Человек часто ставит приложение, не закрывая вкладку: нажал «Показать, где
   * кнопка», свернул Safari, поставил иконку, вернулся. К этому моменту он уже
   * в standalone, а переменная installOpen осталась бы `true` — и подсказка
   * перекрыла бы работающее приложение до перезагрузки страницы.
   *
   * Поэтому состояние перепроверяется при возврате на экран, а не только при
   * первом рендере. Условие то же самое, что и на старте: приложение
   * установлено — подсказки нет.
   */
  useEffect(() => {
    if (!installOpen) return;

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (!shouldShowInstallPrompt()) setInstallOpen(false);
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('appinstalled', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('appinstalled', onVisible);
    };
  }, [installOpen]);

  useEffect(() => {
    // Истёкший токен убираем сразу: оставить его значило бы каждый раз
    // отправлять заведомо мёртвый заголовок и получать 401 вместо нормального
    // объяснения на экране входа.
    if (getPwaToken() && isPwaTokenExpired()) clearPwaToken();
    if (!hasUsablePwaToken() && isGuestMode()) clearGuestMode();

    setPhase(hasUsablePwaToken() ? 'ready' : 'welcome');
  }, []);

  useEffect(() => {
    // Публичный конфиг нужен, чтобы не показывать гостевую кнопку при
    // закрытом рубильнике. Ошибка сети не должна прятать вход: пусть сервер
    // ответит окончательно при создании сессии.
    void api
      .authConfig()
      .then((config) => setRegistrationOpen(config.registrationOpen ?? true))
      .catch(() => setRegistrationOpen(true));
  }, []);

  useEffect(() => {
    // Выход с устройства стирает токен из модуля auth, но не меняет состояние
    // здесь. Без подписки на событие приложение осталось бы на месте с
    // данными, которые сервер больше не отдаёт.
    const onSignedOut = () => {
      clearGuestMode();
      setPhase('welcome');
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);

    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  useEffect(() => {
    // Снимаем статический splash из index.html: React смонтировался, значит
    // на экране уже есть контент (вход, установка или приложение). Эффект
    // срабатывает после первого кадра, поэтому исчезновение splash незаметно —
    // он был ровно того же цвета, что и фон приложения. Пустого белого кадра
    // между ними не возникает.
    document.getElementById('mood-splash')?.remove();
  }, []);

  /** Вход состоялся — открываем приложение. */
  function onAuthenticated(_issued: PwaTokenResponse): void {
    clearGuestMode();
    haptic('medium');
    setPhase('ready');
  }

  /** Гостевая сессия создана: токен уже выдан сервером. */
  function onGuestAuthenticated(issued: PwaTokenResponse): void {
    setPwaToken(issued.token, issued.expiresAt);
    setGuestMode();
    setPhase('ready');
  }

  /**
   * Сессия в БАРС истекла, а токен PWA жив.
   *
   * Экран входа показывается поверх приложения, но токен при этом сохраняется:
   * он никуда не делся, и повторный вход его обновит. Сбрасывать его здесь
   * означало бы выкидывать человека из приложения из-за истёкшей сессии БАРС.
   */
  function onReLogin(): void {
    setPhase('welcome');
  }

  if (debugOpen) return <DiagnosticsScreen onClose={() => setDebugOpen(false)} />;

  // Прежний InstallPrompt обслуживает Android и десктоп; на iOS его заменяет
  // IosInstallGuide (там нужен шаг «Открыть в Safari» и показ при каждой загрузке).
  if (installOpen && !isIOS()) return <InstallPrompt onSkip={() => setInstallOpen(false)} />;

  if (phase === 'guest') {
    return (
      <GuestOnboarding
        onDone={onGuestAuthenticated}
        onBack={() => setPhase('welcome')}
        registrationOpen={registrationOpen}
      />
    );
  }

  if (phase === 'welcome') {
    return (
      <>
        <LoginScreen
          onAuthenticated={onAuthenticated}
          onCancel={onReLogin}
          onTwoFactorChange={setTwoFactorActive}
          onGuest={() => setPhase('guest')}
          guestAllowed={registrationOpen !== false}
        />
        {iosGuide && !twoFactorActive ? <IosInstallGuide /> : null}
      </>
    );
  }

  return (
    <>
      <ScheduleApp onReLogin={onReLogin} guestHint={isGuestMode()} />
      {iosGuide ? <IosInstallGuide /> : null}
    </>
  );
}

/** Что показать в поле ошибки: серверский текст или запасной вариант. */
function errorText(err: unknown, fallback: string): string {
  return err instanceof AuthError ? err.message : fallback;
}

/**
 * Экран входа по логину и паролю БАРС.
 *
 * Двухшаговый: логин с паролем, а если БАРС прислал код подтверждения — экран
 * ввода кода. Шаг хранится прямо здесь, а не в истории: код приходит в SMS или
 * в приложение БАРС, то есть мимо этого экрана, и возвращаться назад человек
 * будет пальцем по экрану.
 *
 * Кнопка одна — «Войти». Отдельного шага регистрации нет: сервер сам заводит
 * запись, если её ещё нет, а логин и пароль от БАРС проверяются в обоих
 * случаях одинаково. Второй кнопкой человек выбирал бы между «что-то
 * одинаковое» и «то же самое», а на первом входе почти всегда ошибался бы
 * именно её.
 *
 * По этой же причине по ошибке входа НЕ предлагается регистрация: сервер
 * отвечает на «неверный логин или пароль» и на «логин в приложении ещё не
 * заведён» одним и тем же кодом, чтобы перебором логинов нельзя было выяснить,
 * кто уже пользуется приложением. Слово «зарегистрируйтесь» после неверного
 * пароля к тому же толкает завести второй аккаунт.
 */
function LoginScreen({
  onAuthenticated,
  onCancel,
  onTwoFactorChange,
  onGuest,
  guestAllowed = true,
}: {
  onAuthenticated: (issued: PwaTokenResponse) => void;
  onCancel: () => void;
  /** Сигнал вверх, что сейчас ввод кода 2FA (чтобы iOS-гайд не перекрывал экран). */
  onTwoFactorChange?: (active: boolean) => void;
  /** Переход в режим «только расписание». */
  onGuest?: () => void;
  /** Рубильник регистрации: при false гостевой вход тоже закрыт. */
  guestAllowed?: boolean;
}) {
  const [step, setStep] = useState<'credentials' | 'code'>('credentials');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Когда перестаёт быть смысл ждать код. 0 = код не запрашивали. */
  const [codeDeadline, setCodeDeadline] = useState(0);
  /** Что показать рядом с полем кода: сколько осталось ждать. */
  const [secondsLeft, setSecondsLeft] = useState(0);
  /** Принятые на этом экране документы. Ни одна галочка не стоит по умолчанию. */
  const [accepted, setAccepted] = useState<Partial<Record<LegalDocId, boolean>>>({});
  /** Push — необязательный канал: галочка не блокирует вход. */
  const [pushAccepted, setPushAccepted] = useState(false);

  const allAccepted = LOGIN_DOCUMENTS.every((document) => accepted[document.id]);

  /**
   * Сообщаем наверх, что идёт ввод кода 2FA: в этот момент iOS-гайд не должен
   * перекрывать экран. Это только сигнал для слоя показа, бизнес-логику входа
   * не задевает.
   */
  useEffect(() => {
    onTwoFactorChange?.(step === 'code');
  }, [step, onTwoFactorChange]);

  /**
   * Обратный отсчёт до конца ожидания кода.
   *
   * Тик каждую секунду нужен только пока код запрошен, поэтому эффект поднимается
   * и опускается вместе с шагом. На нуле экран сам возвращается к логину с
   * паролем: ждать дальше нечего, а код в БАРС к этому моменту уже недействителен.
   */
  useEffect(() => {
    if (step !== 'code' || !codeDeadline) return;

    const tick = () => {
      const left = Math.max(0, Math.ceil((codeDeadline - Date.now()) / 1000));
      setSecondsLeft(left);

      if (left === 0) {
        setStep('credentials');
        setCode('');
        setChallengeId('');
        setCodeDeadline(0);
        setError('Код не пришёл за пять минут. Проверьте уведомления и войдите заново.');
      }
    };

    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [step, codeDeadline]);

  /** Отправляет логин с паролем. Запись заводится сервером, если её ещё нет. */
  async function submitCredentials() {
    const trimmed = login.trim();
    if (!trimmed || !password) {
      setError('Введите логин и пароль.');
      return;
    }

    if (!allAccepted) {
      setError('Отметьте все документы, чтобы продолжить.');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const consents = LOGIN_DOCUMENTS.filter((document) => accepted[document.id]).map(
        (document) => document.id,
      );
      if (pushAccepted) consents.push('push');
      const result = await loginWithPassword(trimmed, password, consents);

      if (isTwoFactorRequired(result)) {
        setChallengeId(result.challengeId);
        setCode('');
        setStep('code');
        setCodeDeadline(Date.now() + TWO_FA_WAIT_MS);
        return;
      }

      onAuthenticated(result);
    } catch (err: unknown) {
      setError(errorText(err, 'Не удалось войти.'));
    } finally {
      setBusy(false);
    }
  }

  function submitCode(event: FormEvent) {
    event.preventDefault();

    const trimmed = code.trim();
    if (!trimmed) return;

    setBusy(true);
    setError(null);

    void (async () => {
      try {
        const issued = await confirmTwoFactor(challengeId, trimmed);
        onAuthenticated(issued);
      } catch (err: unknown) {
        // Попытка входа в БАРС на сервере уже израсходована: код одноразовый,
        // и второй запрос с тем же challengeId вернёт «попытка истекла».
        // Поэтому после неудачи возвращаемся к логину с паролем, а не даём
        // человеку бить в пустую стену.
        setStep('credentials');
        setPassword('');
        setCodeDeadline(0);
        setError(
          err instanceof AuthError && err.error === 'invalid_credentials'
            ? 'Код не подошёл. Войдите заново логином и паролем.'
            : errorText(err, 'Код не подошёл. Войдите заново.'),
        );
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain">
      <div
        className="mx-auto flex min-h-full w-full max-w-[440px] flex-col justify-center gap-6 px-6 py-10"
        style={{ paddingBottom: 'calc(2.5rem + env(safe-area-inset-bottom, 0px))' }}
      >
      <div className="flex flex-col items-center gap-3 text-center">
        <img src="/icons/site-icon-192.png?v=2" width={64} height={64} alt="" className="rounded-[16px]" />
        <h1 className="text-[22px] font-semibold">Mood — расписание МЭИ</h1>
        <p className="text-[15px] leading-snug text-[var(--text-secondary)]">
          Войдите логином и паролем от личного кабинета НИУ МЭИ.
        </p>
      </div>

      {step === 'credentials' ? (
        <div className="space-y-3 rounded-[16px] border border-[var(--separator-soft)] bg-[var(--surface)] p-4">
          <p className="text-[13px] leading-snug text-[var(--text-secondary)]">
            Перед входом примите документы. Каждый пункт — отдельно, галочки не
            проставлены заранее.
          </p>

          {LOGIN_DOCUMENTS.map((document) => (
            <label key={document.id} className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={!!accepted[document.id]}
                onChange={(event) =>
                  setAccepted((prev) => ({ ...prev, [document.id]: event.target.checked }))
                }
                className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
              />
              <span className="text-[13px] leading-snug">
                Я принимаю{' '}
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openLink(document.url);
                  }}
                  className="text-left font-medium underline decoration-[var(--accent)] underline-offset-2"
                  style={{ color: 'var(--accent)' }}
                >
                  {document.title}
                </button>
              </span>
            </label>
          ))}

          <label className="flex items-start gap-3 border-t border-[var(--separator-soft)] pt-3">
            <input
              type="checkbox"
              checked={pushAccepted}
              onChange={(event) => setPushAccepted(event.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
            />
            <span className="text-[13px] leading-snug">
              Хочу push-уведомления.{' '}
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openLink(PUSH_DOCUMENT.url);
                }}
                className="text-left font-medium underline decoration-[var(--accent)] underline-offset-2"
                style={{ color: 'var(--accent)' }}
              >
                {PUSH_DOCUMENT.title}
              </button>{' '}
              <span className="text-[var(--text-tertiary)]">(необязательно)</span>
            </span>
          </label>

          <button
            type="button"
            onClick={() => openLink(POLICY_LINK.url)}
            className="text-left text-[12px] leading-snug underline decoration-[var(--separator-soft)] underline-offset-2"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {POLICY_LINK.title}
          </button>
        </div>
      ) : null}

      {step === 'credentials' ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCredentials();
          }}
        >
          <input
            value={login}
            onChange={(event) => setLogin(event.target.value)}
            placeholder="Логин, например st123456"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            className="w-full rounded-[12px] border border-[var(--separator-soft)] bg-[var(--surface)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />

          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            placeholder="Пароль"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            className="w-full rounded-[12px] border border-[var(--separator-soft)] bg-[var(--surface)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />

          {error ? (
            <p className="text-[13px] leading-snug text-[var(--danger)]">{error}</p>
          ) : null}

          <button
            type="submit"
            disabled={busy || !allAccepted}
            className="pressable pressable-active w-full rounded-[14px] bg-[var(--accent)] px-4 py-3.5 text-[16px] font-semibold text-white disabled:opacity-40"
          >
            {busy ? 'Проверяем…' : 'Войти'}
          </button>
        </form>
      ) : (
        <form className="space-y-3" onSubmit={submitCode}>
          <p className="text-[14px] leading-snug text-[var(--text-secondary)]">
            БАРС прислал код подтверждения на {login.trim()}. Введите его — вход продолжится.
          </p>

          {secondsLeft > 0 ? (
            <p className="text-center text-[12px] leading-snug text-[var(--text-tertiary)]">
              Код действует ограниченное время. Если он не придёт, экран вернётся к входу
              через {secondsLeft} с.
            </p>
          ) : null}

          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Код из СМС или приложения БАРС"
            inputMode="numeric"
            autoComplete="one-time-code"
            enterKeyHint="go"
            autoFocus
            className="w-full rounded-[12px] border border-[var(--separator-soft)] bg-[var(--surface)] px-3 py-2.5 text-center text-[20px] tracking-[0.3em] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />

          {error ? (
            <p className="text-[13px] leading-snug text-[var(--danger)]">{error}</p>
          ) : null}

          <button
            type="submit"
            disabled={busy || code.trim().length === 0}
            className="pressable pressable-active w-full rounded-[14px] bg-[var(--accent)] px-4 py-3.5 text-[16px] font-semibold text-white disabled:opacity-40"
          >
            {busy ? 'Проверяем…' : 'Подтвердить'}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setStep('credentials');
              setCode('');
              setCodeDeadline(0);
              setError(null);
            }}
            className="pressable pressable-active w-full rounded-[12px] px-4 py-2.5 text-[14px] font-semibold text-[var(--text-secondary)] disabled:opacity-40"
          >
            Назад
          </button>
        </form>
      )}

      {step === 'credentials' && onGuest && guestAllowed ? (
        <button
          type="button"
          disabled={busy}
          onClick={onGuest}
          className="pressable pressable-active w-full rounded-[14px] border border-[var(--separator-soft)] px-4 py-3 text-[15px] font-semibold text-[var(--accent)] disabled:opacity-40"
        >
          Продолжить только с расписанием
        </button>
      ) : null}

      {/*
        Отмена нужна только когда вход инициирован изнутри приложения: сессия
        БАРС истекла, токен PWA ещё жив, и человек должен вернуться к
        расписанию, а не застрять на экране входа.
      */}
      {hasUsablePwaToken() && step === 'credentials' ? (
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="pressable pressable-active w-full rounded-[12px] px-4 py-2.5 text-[14px] font-semibold text-[var(--text-tertiary)] disabled:opacity-40"
        >
          Вернуться в приложение
        </button>
      ) : null}

      <p className="text-center text-[12px] leading-snug text-[var(--text-tertiary)]">
        Логин и пароль уходят только на сервер Mood и в БАРС МЭИ. Токен хранится
        только в этом браузере и никуда не передаётся.
      </p>
      </div>
    </div>
  );
}
