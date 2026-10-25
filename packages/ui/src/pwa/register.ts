/**
 * Registers the service worker (`/sw.js`: the app shell offline, web push) as soon as the app starts, signed in or
 * not, and announces a new version of the app (`kosh:update` on `window`, with the reload), so the shell can offer
 * a reload: a deploy is never silent, and never forced mid-work.
 */
let registered = false;

export function registerServiceWorker(): void {
  if (registered || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  registered = true;
  navigator.serviceWorker
    .register('/sw.js')
    .then((registration) => {
      const watch = (worker: ServiceWorker | null) => {
        if (worker === null) return;
        worker.addEventListener('statechange', () => {
          // Installed behind a running page: a new version (the first install has no controller).
          if (worker.state === 'installed' && navigator.serviceWorker.controller !== null)
            window.dispatchEvent(
              new CustomEvent('kosh:update', {
                detail: { reload: () => window.location.reload() },
              }),
            );
        });
      };
      watch(registration.installing);
      registration.addEventListener('updatefound', () => watch(registration.installing));
    })
    .catch(() => {
      registered = false; // not available (insecure origin, a blocked script): nothing to do
    });
}

/** Listens for a new version of the app; the listener gets the reload. Returns the way to stop listening. */
export function onAppUpdate(listener: (reload: () => void) => void): () => void {
  const handler = (event: Event) =>
    listener((event as CustomEvent<{ reload: () => void }>).detail.reload);
  window.addEventListener('kosh:update', handler);
  return () => window.removeEventListener('kosh:update', handler);
}
