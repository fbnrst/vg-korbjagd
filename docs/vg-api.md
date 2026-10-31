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

Verknüpfung: `product.unitID` → Units, `product.manufacturerID` → Manufacturers, `product.countryID` → Countries. Produkte haben **keine EAN**, nur die VG-Nummer.

Antworten sind JSON, kommen aber mit `Content-Type: text/html` und **ohne CORS-Header**. Browser können die Endpunkte daher nicht direkt abrufen, ein Server muss sie weiterreichen (die Original-App empfiehlt für die Entwicklung eine CORS-Erweiterung).

## Aktualisierung über Prüfsummen

Die App ruft zuerst `getChecksums.php` ab, vergleicht je Tabelle mit der lokal gespeicherten Prüfsumme und lädt nur geänderte Listen neu. Zuordnung Tabelle → Endpunkt: `manufacturers`, `countries`, `vg-products`, `units`, `deposit`.

## Schreibende Endpunkte (nicht abgefragt)

Die App ruft außerdem `shareList.php`, `getSharedList.php` und `sendFeedback.php` auf (Listen teilen/importieren, Feedback). Sie wurden bewusst nicht ausprobiert; Details siehe Quelltext der Original-App.

## Pläne für vg-korbjagd

Proxy mit Zwischenspeicher (z. B. Cloudflare Worker, da die App keinen eigenen Server mehr hat) (z. B. 24 h plus Prüfsummenvergleich) und Verknüpfung mit der VG-Nummer-Eingabe (Titel, Einheit, Hersteller, Land automatisch eintragen, Pfand). Noch nicht umgesetzt.
