# VG Dresden endpoints (unofficial documentation)

The original app ([gitlab.com/pyfox/vg-app](https://gitlab.com/pyfox/vg-app), GPLv3) loads its master data from `https://app.vg-dresden.de/php/`. This description comes from the app's source code (`src/shared/DataManager.tsx`) and from requests made on 2026-10-31; the number and size of the entries are the state at that time (most recently only checked against `public/vg.js`, the endpoints were not reachable). It is **not official API documentation**; endpoints and formats can change at any time. Before productive use or redistribution of the data, please ask VG Dresden (info@vg-dresden.de).

## Read endpoints (GET, no login)

| Endpoint | Entries | Size | Fields |
|---|---|---|---|
| `getProductList.php` | 9034 | about 1.1 MB | `id`, `vgNum`, `unitID`, `manufacturerID`, `countryID`, `title`, `isRegional` (0/1) |
| `getManufacturersList.php` | 1323 | about 89 KB | `id`, `short`, `manufacturer` |
| `getCountriesList.php` | 186 | about 9 KB | `id`, `code`, `country` |
| `getUnitsList.php` | 430 | about 18 KB | `id`, `short`, `unit` |
| `getDepositsList.php` | 18 | about 1 KB | `id`, `code`, `name`, `vgNum` (deposit) |
| `getChecksums.php` | 5 | < 1 KB | `table` (e.g. `d02fcebe.vg-products`), `checksum` |

Examples:

    getProductList.php   -> [{"id":1,"vgNum":7900,"unitID":2,"manufacturerID":158,"countryID":31,"title":"Fruchtwürfel- mischung","isRegional":0}, …]
    getChecksums.php     -> [{"table":"d02fcebe.countries","checksum":3053541427}, …]

About a fifth of the entries (1904 of 9034, as of 2026-10-31) are not real products but unused number slots with titles like "unbesetzt …" or "RESERVIERT …". The app never suggests them (`isPlaceholder` in `public/vg.js`, neither for names nor for numbers). A fully typed number is still accepted if the shop uses it although the database says "unbesetzt"; the item then gets the entry's title (e.g. "unbesetzt Backwaren").

Links: `product.unitID` → Units, `product.manufacturerID` → Manufacturers, `product.countryID` → Countries. Products have **no EAN**, only the VG number.

Responses are JSON but come with `Content-Type: text/html`.

**CORS:** as soon as the browser sends an `Origin` header, the endpoints answer (also to the `OPTIONS` preflight) with `access-control-allow-origin: *`. A plain `curl` without `Origin` does not show the header, which misled us at first. Browser apps can therefore fetch the data directly, no proxy is needed. Implemented in `public/vg.js`.

## Updating through checksums

`loadVg` in `public/vg.js` first calls `getChecksums.php` and compares all checksums together with the stored one (cache `kober-vg-v2` in `localStorage`). If they are equal or the network is gone, the cache is used. Otherwise all five lists (products, manufacturers, countries, units, deposits) are reloaded, not only the changed one. Timeout per request: 20 s.

## Shared lists of the original app

The original app shares lists as a link `https://app.vg-dresden.de/list?shareId=<ID>#<KEY>`.

- `getSharedList.php` (POST, JSON `{"shareId": "<ID>"}`) returns the text of the list.
- The text is encrypted with CryptoJS AES (passphrase mode). The key sits only in the link fragment (`#…`) and never goes to the server.
- Decrypted, it is a JSON array of `{title, id, amount, unit?, vgNum?, country?, checked, date, hasVgNum, order}`.

Kober no longer uses these links: the former import (menu "Import list", `parseShareLink`, `decryptShared`, CryptoJS) was removed. The description stays as documentation of the format.

## Other endpoints (not queried)

`shareList.php` (share a list, writes to the VG server) and `sendFeedback.php` were deliberately not tried. Sending a list from Kober to the original app would be technically possible through `shareList.php`, but it writes to the VG server and is therefore not implemented.
