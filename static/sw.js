'use strict';

/*
 * GitHub Pages отдаёт .mobileconfig как application/octet-stream,
 * из-за чего iOS не предлагает установку профиля. Этот service worker
 * перехватывает файл и возвращает его с правильным типом
 * application/x-apple-aspen-config.
 */

var PROFILE_SUFFIX = '/max-block.mobileconfig';

self.addEventListener('install', function () {
    self.skipWaiting();
});

self.addEventListener('activate', function (event) {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (request.method !== 'GET') return;

    var url;
    try {
        url = new URL(request.url);
    } catch (e) {
        return;
    }

    if (url.origin !== self.location.origin) return;
    if (url.pathname.slice(-PROFILE_SUFFIX.length) !== PROFILE_SUFFIX) return;

    event.respondWith(serveProfile(request));
});

function serveProfile(request) {
    return fetch(request.url, { cache: 'no-store', credentials: 'same-origin' })
        .then(function (response) {
            if (!response.ok) return response;
            return response.arrayBuffer().then(function (body) {
                return new Response(body, {
                    status: 200,
                    statusText: 'OK',
                    headers: {
                        'Content-Type': 'application/x-apple-aspen-config',
                        'Content-Disposition': 'inline; filename="max-block.mobileconfig"',
                        'Cache-Control': 'no-store, no-cache, must-revalidate'
                    }
                });
            });
        });
}
