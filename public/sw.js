const CACHE_NAME = 'dubstack-assets-v1';
const ASSETS_TO_CACHE_EXTENSIONS = [
    '.onnx',
    '.wasm',
    '.mp4',
    '.json',
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const extension = url.pathname.slice(((url.pathname.lastIndexOf(".") - 1) >>> 0) + 2);

    const isCachableAsset = ASSETS_TO_CACHE_EXTENSIONS.some(ext =>
        url.pathname.endsWith(ext)
    ) || url.pathname.includes('/models/') || url.pathname.includes('/videos/');

    if (isCachableAsset && event.request.method === 'GET') {
        event.respondWith(
            caches.open(CACHE_NAME).then((cache) => {
                return cache.match(event.request).then((response) => {
                    if (response) {
                        return response;
                    }
                    return fetch(event.request).then((networkResponse) => {
                        if (networkResponse.status === 200 || networkResponse.status === 206) {
                            cache.put(event.request, networkResponse.clone());
                        }
                        return networkResponse;
                    });
                });
            })
        );
    }
});
