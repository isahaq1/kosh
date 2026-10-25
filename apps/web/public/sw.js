/**
 * Kosh's service worker: web push (RFC 0006 §5.4). A push message carries { title, body, url, id }; clicking the
 * notification focuses an open Kosh tab (or opens one) on the record. Nothing is cached here yet.
 */
self.addEventListener('push', (event) => {
  let data = { title: 'Kosh', body: '', url: '/', id: 0 };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    // not JSON: shown as is
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { url: data.url, id: data.id },
      tag: `kosh-${data.id}`,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const open = clients.find((c) => c.url.startsWith(self.location.origin));
      if (open !== undefined) {
        open.focus();
        return open.navigate(url);
      }
      return self.clients.openWindow(url);
    }),
  );
});
