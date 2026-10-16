import { useEffect, useState, type FormEvent } from 'react';

import { ScheduleApp } from '@/app/ScheduleApp';
import { InstallPrompt, shouldShowInstallPrompt } from '@/components/InstallPrompt';
import { IosInstallGuide, useShouldShowIosInstallGuide } from '@/components/IosInstallGuide';
import { DiagnosticsScreen } from '@/DiagnosticsScreen';
import { haptic, isIOS } from '@/lib/env';
import {
  AuthError,
  confirmTwoFactor,
  hasUsablePwaToken,
  isPwaTokenExpired,
  isTwoFactorRequired,
  loginWithPassword,
  clearPwaToken,
  getPwaToken,
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

type Phase = 'ready' | 'welcome';

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

    setPhase(hasUsablePwaToken() ? 'ready' : 'welcome');
  }, []);

  useEffect(() => {
    // Выход с устройства стирает токен из модуля auth, но не меняет состояние
    // здесь. Без подписки на событие приложение осталось бы на месте с
    // данными, которые сервер больше не отдаёт.
    const onSignedOut = () => setPhase('welcome');
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);

    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  useEffect(() => {
    // Снимаем статический splash из index.html: React смонтировался, значит
    // на экране уже есть контент (вход, установка или приложение). Эффект
    // срабатывает после первого кадра, поэтому исчезновение splash незаметно —
    // он был ровно того же цвета, что и фон приложения. Пустого белого кадра
    // между ними не возникает.
    document.getElementById('hub-splash')?.remove();
  }, []);

  /** Вход состоялся — открываем приложение. */
  function onAuthenticated(_issued: PwaTokenResponse): void {
    haptic('medium');
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

  if (phase === 'welcome') {
    return (
      <>
        <LoginScreen
          onAuthenticated={onAuthenticated}
          onCancel={onReLogin}
          onTwoFactorChange={setTwoFactorActive}
        />
        {iosGuide && !twoFactorActive ? <IosInstallGuide /> : null}
      </>
    );
  }

  return (
    <>
      <ScheduleApp onReLogin={onReLogin} />
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
}: {
  onAuthenticated: (issued: PwaTokenResponse) => void;
  onCancel: () => void;
  /** Сигнал вверх, что сейчас ввод кода 2FA (чтобы iOS-гайд не перекрывал экран). */
  onTwoFactorChange?: (active: boolean) => void;
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

    setBusy(true);
    setError(null);

    try {
      const result = await loginWithPassword(trimmed, password);

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
    <div className="mx-auto flex min-h-full w-full max-w-[440px] flex-col justify-center gap-6 px-6 py-10">
      <div className="flex flex-col items-center gap-3 text-center">
        <img src="/icons/icon-192.png" width={64} height={64} alt="" className="rounded-[16px]" />
        <h1 className="text-[22px] font-semibold">Hub — расписание МЭИ</h1>
        <p className="text-[15px] leading-snug text-[var(--text-secondary)]">
          Войдите логином и паролем от личного кабинета НИУ МЭИ.
        </p>
      </div>

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
            disabled={busy}
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
        Логин и пароль уходят только на сервер Hub и в БАРС МЭИ. Токен хранится
        только в этом браузере и никуда не передаётся.
      </p>
    </div>
  );
}
