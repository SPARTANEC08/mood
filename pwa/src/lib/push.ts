/**
 * Web Push на стороне браузера.
 *
 * Разрешение и подписка — две разные вещи. Разрешение человек выдаёт один раз
 * на origin; подписка живёт в браузере и имеет свой адрес в push-сервисе.
 * Сервер знает только адрес и публичные ключи, поэтому при потере подписки
 * (переустановка PWA, чистка данных сайта) её нужно создать заново и отправить
 * на сервер — этим занимается syncPush при каждом старте.
 *
 * На iOS push работают только в установленной PWA (iOS 16.4+), и запрос
 * разрешения обязан идти из обработчика тапа. Поэтому «автоматически после
 * установки» здесь означает: приложение само предлагает включить одной
 * кнопкой, но не выкидывает системное окно без действия человека.
 */

import { api } from '@/lib/api';

export type PushSupport = 'ready' | 'unsupported' | 'ios-not-installed';

/** Приложение открыто с домашнего экрана, а не во вкладке браузера. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;

  const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    navigatorWithStandalone.standalone === true
  );
}

/** iOS/iPadOS: Web Push существует только в установленном приложении. */
function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;

  const ua = navigator.userAgent;
  // iPadOS 13+ представляется как Mac; отличаем по тач-экрану.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function pushSupport(): PushSupport {
  if (!pushSupported()) return 'unsupported';
  if (isIos() && !isStandalone()) return 'ios-not-installed';
  return 'ready';
}

export function pushPermission(): NotificationPermission | 'unsupported' {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission;
}

/** VAPID-ключ приходит строкой base64url, а pushManager ждёт байты. */
export function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(normalized);
  // Отдельный ArrayBuffer: pushManager принимает BufferSource с ArrayBuffer,
  // а не с ArrayBufferLike (SharedArrayBuffer в типах не подходит).
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);

  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }

  return bytes;
}

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;

  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

/** Текущая подписка браузера, если она есть. */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  const registration = await readyRegistration();
  if (!registration) return null;

  try {
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** Отправляет подписку на сервер. Идемпотентно по endpoint. */
async function rememberSubscription(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();

  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return;

  await api.pushSubscribe({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

/**
 * Создаёт (или переиспользует) подписку и сохраняет её на сервере.
 *
 * Вызывается из обработчика тапа: requestPermission вне жеста на iOS молча
 * отклоняется, и человек видит «ничего не произошло».
 */
export async function enablePush(): Promise<boolean> {
  if (pushSupport() !== 'ready') return false;

  try {
    const permission =
      Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission();

    if (permission !== 'granted') return false;

    const registration = await readyRegistration();
    if (!registration) return false;

    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      await rememberSubscription(existing);
      return true;
    }

    const { publicKey } = await api.pushKey();
    if (!publicKey) return false;

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    await rememberSubscription(subscription);
    return true;
  } catch {
    return false;
  }
}

/**
 * Полная отписка устройства: и в браузере, и на сервере.
 *
 * Нужна при выходе из аккаунта. Иначе пуши продолжали бы приходить на
 * устройство, с которого человек уже вышел, — и показывали бы чужие события
 * следующему, кто возьмёт телефон.
 */
export async function disablePush(): Promise<void> {
  const subscription = await getPushSubscription();
  if (!subscription) return;

  try {
    await api.pushUnsubscribe(subscription.endpoint);
  } catch {
    // Сервер мог быть недоступен — локальную подписку всё равно снимаем.
  }

  try {
    await subscription.unsubscribe();
  } catch {
    // Браузер мог уже удалить подписку сам.
  }
}

/**
 * Приводит сервер и браузер к одному состоянию при старте приложения.
 *
 * Если разрешение уже выдано, подписка должна существовать и быть известна
 * серверу: после переустановки PWA или очистки данных сайта в браузере
 * появляется новый endpoint, а на сервере остаётся мёртвый. Разрешение при
 * этом не запрашивается — только восстановление уже выданного.
 */
export async function syncPush(): Promise<{ subscribed: boolean }> {
  if (pushSupport() !== 'ready' || Notification.permission !== 'granted') {
    return { subscribed: false };
  }

  try {
    const registration = await readyRegistration();
    if (!registration) return { subscribed: false };

    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      const { publicKey } = await api.pushKey();
      if (!publicKey) return { subscribed: false };

      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    await rememberSubscription(subscription);
    return { subscribed: true };
  } catch {
    return { subscribed: false };
  }
}
