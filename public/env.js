// Release or dev site? Both are served from the same origin (the release at /, the current main at /dev/), so everything the
// browser stores for the app gets a prefix on the dev site: a dev build must never touch the data of the release.
export const IS_DEV = /\/dev\//.test(globalThis.location?.pathname || '');
export const NS = IS_DEV ? 'dev:' : '';
