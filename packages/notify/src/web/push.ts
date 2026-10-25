/**
 * Web push on this device: whether the browser can, whether this device is subscribed, and the switch. The
 * service worker (`/sw.js`) shows the messages; the subscription (endpoint and keys the browser makes) is saved
 * on the server for the signed-in user. The server's public VAPID key says whether push is set up at all.
 */
import type { KoshApi } from '@kosh/ui';
import { useCallback, useEffect, useState } from 'react';

export type PushState = 'unsupported' | 'unavailable' | 'off' | 'on' | 'denied' | 'busy';

function toBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = `${base64url}${'='.repeat((4 - (base64url.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The push switch of this device. */
export function usePush(api: KoshApi): { readonly state: PushState; toggle(): Promise<void> } {
  const [state, setState] = useState<PushState>('busy');
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (
        typeof window === 'undefined' ||
        !('serviceWorker' in navigator) ||
        !('PushManager' in window) ||
        !('Notification' in window)
      ) {
        setState('unsupported');
        return;
      }
      const server = await api
        .call<{ publicKey: string }>('GET', '/api/v1/notifications/push/key')
        .catch(() => null);
      if (!alive) return;
      if (server === null) {
        setState('unavailable');
        return;
      }
      setKey(server.publicKey);
      if (Notification.permission === 'denied') {
        setState('denied');
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration('/sw.js');
      const current = await registration?.pushManager.getSubscription();
      if (alive) setState(current === null || current === undefined ? 'off' : 'on');
    })().catch(() => setState('unavailable'));
    return () => {
      alive = false;
    };
  }, [api]);

  const toggle = useCallback(async () => {
    if (key === null || state === 'busy') return;
    const previous = state;
    setState('busy');
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      const current = await registration.pushManager.getSubscription();
      if (current !== null) {
        await api.call('DELETE', '/api/v1/notifications/push', { endpoint: current.endpoint });
        await current.unsubscribe();
        setState('off');
        return;
      }
      if ((await Notification.requestPermission()) !== 'granted') {
        setState('denied');
        return;
      }
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toBytes(key),
      });
      const json = subscription.toJSON();
      await api.call('POST', '/api/v1/notifications/push', {
        endpoint: json.endpoint,
        keys: json.keys,
      });
      setState('on');
    } catch {
      setState(previous);
    }
  }, [api, key, state]);

  return { state, toggle };
}
