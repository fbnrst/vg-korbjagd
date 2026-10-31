# VG-Dresden-Endpunkte (inoffiziell dokumentiert)

Die Original-App ([gitlab.com/pyfox/vg-app](https://gitlab.com/pyfox/vg-app), GPLv3) lädt ihre Stammdaten von `https://app.vg-dresden.de/php/`. Diese Beschreibung stammt aus dem Quelltext der App (`src/shared/DataManager.tsx`) und aus Abfragen am 2026-10-31. Es ist **keine offizielle API-Doku**; Endpunkte und Formate können sich jederzeit ändern. Vor produktiver Nutzung oder Weiterverbreitung der Daten bitte bei der VG Dresden nachfragen (info@vg-dresden.de).

## Lese-Endpunkte (GET, ohne Anmeldung)

| Endpunkt | Einträge | Größe | Felder |
|---|---|---|---|
| `getProductList.php` | 9034 | ca. 1,1 MB | `id`, `vgNum`, `unitID`, `manufacturerID`, `countryID`, `title`, `isRegional` (0/1) |
| `getManufacturersList.php` | 1323 | ca. 89 KB | `id`, `short`, `manufacturer` |
| `getCountriesList.php` | 186 | ca. 9 KB | `id`, `code`, `country` |
| `getUnitsList.php` | 430 | ca. 18 KB | `id`, `short`, `unit` |
| `getDepositsList.php` | 18 | ca. 1 KB | `id`, `code`, `name`, `vgNum` (Pfand) |
| `getChecksums.php` | 5 | < 1 KB | `table` (z. B. `d02fcebe.vg-products`), `checksum` |

Beispiele:

    getProductList.php   -> [{"id":1,"vgNum":7900,"unitID":2,"manufacturerID":158,"countryID":31,"title":"Fruchtwürfel- mischung","isRegional":0}, …]
    getChecksums.php     -> [{"table":"d02fcebe.countries","checksum":3053541427}, …]

Rund ein Fünftel der Einträge (1904 von 9034, Stand 2026-10-31) sind keine echten Produkte, sondern unbenutzte Nummernplätze mit Titeln wie „unbesetzt …“ oder „RESERVIERT …“. Die App schlägt sie nie vor (`isPlaceholder` in `public/vg.js`, weder bei Namen noch bei Nummern). Eine vollständig getippte Nummer wird trotzdem angenommen, falls der Laden sie benutzt, obwohl die Datenbank „unbesetzt“ sagt; der Artikel heißt dann so wie der Eintrag (z. B. „unbesetzt Backwaren“).

Verknüpfung: `product.unitID` → Units, `product.manufacturerID` → Manufacturers, `product.countryID` → Countries. Produkte haben **keine EAN**, nur die VG-Nummer.

Antworten sind JSON, kommen aber mit `Content-Type: text/html`.

**CORS:** Sobald der Browser einen `Origin`-Header mitschickt, antworten die Endpunkte (auch auf den `OPTIONS`-Preflight) mit `access-control-allow-origin: *`. Ein einfacher `curl` ohne `Origin` zeigt den Header nicht, das hatte uns zunächst getäuscht. Browser-Apps können die Daten also direkt abrufen, ein Proxy ist nicht nötig. Umgesetzt in `public/vg.js` (Cache im `localStorage`, Aktualisierung über die Prüfsummen).

## Aktualisierung über Prüfsummen

Die App ruft zuerst `getChecksums.php` ab, vergleicht je Tabelle mit der lokal gespeicherten Prüfsumme und lädt nur geänderte Listen neu. Zuordnung Tabelle → Endpunkt: `manufacturers`, `countries`, `vg-products`, `units`, `deposit`.

## Geteilte Listen der Original-App

Die Original-App teilt Listen als Link `https://app.vg-dresden.de/list?shareId=<ID>#<SCHLÜSSEL>`.

- `getSharedList.php` (POST, JSON `{"shareId": "<ID>"}`) liefert den Text der Liste.
- Der Text ist mit CryptoJS-AES (Passphrase-Modus) verschlüsselt. Der Schlüssel steht nur im Link-Fragment (`#…`) und geht nie an den Server.
- Entschlüsselt ergibt sich ein JSON-Array von `{title, id, amount, unit?, vgNum?, country?, checked, date, hasVgNum, order}`.

vg-korbjagd importiert solche Links (Knopf „📥 VG-App“ oder Link ins Eingabefeld einfügen), siehe `fetchSharedList` / `decryptShared` in `public/vg.js`.

## Weitere Endpunkte (nicht abgefragt)

`shareList.php` (Liste teilen, schreibt auf den VG-Server) und `sendFeedback.php` wurden bewusst nicht ausprobiert. Eine Liste aus vg-korbjagd an die Original-App zu schicken wäre über `shareList.php` technisch möglich, schreibt aber auf den VG-Server und ist deshalb nicht umgesetzt.
