# Architektur

Orientierung für Entwickler: wo was liegt und wie die Teile zusammenspielen. Verhaltensregeln im Detail (Punkte, Namensprüfung, Layout, Barrierefreiheit, Overload-Verhalten) stehen in [AGENTS.md](../AGENTS.md), die Bedienung auf der Hilfeseite `public/docs/index.html`.

Kober ist eine statische Seite ohne Server und ohne Build-Schritt (ES-Module, GitHub Pages). Die Liste liegt zuerst nur im `localStorage` (Code `LOCAL`). Erst beim Teilen zieht sie in die Firebase Realtime Database um; alle Geräte abonnieren dann dieselbe Liste. VG-Server, Open Food Facts und Firebase werden direkt aus dem Browser angesprochen.

## Modulübersicht (`public/`)

| Datei | Aufgabe |
|---|---|
| `index.html`, `theme.css` | Gerüst, Ansichten und Dialoge; `theme.css` ist die einzige Stelle für Farben (hell/dunkel) |
| `app.js` | Oberfläche, Ereignisse, Scanner, Dialoge, Start (`init`), Teilen/Beitreten/Verlassen/Löschen |
| `flows.js` | reine Logik hinter Abläufen von `app.js` (Zurücksetzen-Plan, zu lange Nummern, Kassen-Haken, VG-Lader, erster Upload) |
| `store.js` | Datenschicht: Adapter (Firebase, lokal), Listenlogik, Punkte, Aktivitätsstempel, Schreib-Zeitlimit (`guardAdapter`) |
| `conn.js` | Verbindungszustand einer geteilten Liste (`ok`, `connecting`, `degraded`, `busy`), Backoff |
| `outbox.js` | Journal wartender Änderungen im `localStorage` |
| `cache.js` | letzter Live-Datensatz je geteilter Liste im `localStorage` |
| `sim.js` | simulierter Server mit Fehlerinjektion (`?sim=…`) und manuelle Uhr für Tests |
| `vg.js` | VG-Stammdaten laden und cachen, Index und Suche, Namensprüfung, Scan-Codes, Import von VG-App-Links |
| `i18n.js` | alle sichtbaren Texte (`STRINGS.en`, `STRINGS.de`), `t()`, `applyStatic()` |
| `a11y.js` | Dialog-Semantik, Fokusfalle, Menü-Tastatur, `shortName()` |
| `env.js` | `IS_DEV` (Pfad `/dev/`) und `NS`, das Präfix für jeden Storage-Schlüssel und Cache-Namen |
| `sw.js` | Service Worker: Dateiliste vorab im Cache, danach Netz zuerst (`no-cache`), bei Fehler Cache |
| `firebase-config.js`, `firebase-config.dev.js` | Firebase-Webkonfiguration (öffentlich); `null` = Demo-Modus |
| `privacy.html`, `docs/index.html`, `legal-config.js` | Datenschutzseite, Hilfeseite (beide zweisprachig), Kontaktangabe |
| `manifest.json`, `icon.svg`, `logo.svg`, `icons/` | PWA-Metadaten und Icons (`npm run icons`) |
| `vendor/` | Fremdbibliotheken (QR-Code, CryptoJS, zxing), von den Prüfungen ausgenommen |

Der Firebase-SDK (10.14.1) wird erst bei Bedarf von `gstatic.com` geladen, der Scanner auf iOS/Safari lädt bei Bedarf `vendor/zxing.min.js` (`@zxing/library@0.21.3`); Chrome/Android nutzt den eingebauten `BarcodeDetector`. Unbekannte EANs werden bei Open Food Facts nachgeschlagen.

## Datenmodell

Alles liegt unter `lists/<CODE>` (6 Zeichen aus `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; die Regeln lassen `^[A-Z0-9]{6}$` zu). Die lokale Liste hat dieselbe Form im `localStorage` (Schlüssel `NS + 'kober-local-db'`), aber ohne Spielstände.

```
lists/<CODE>/
  meta/created            Zeitstempel, nur einmal schreibbar
  activity                Zeitstempel (ms), höchstens stündlich gestempelt
  items/<id>              id, title, amount, checked, addedBy, addedAt  (Pflicht)
                          unit, info, vgNum, ean, checkedBy, checkedAt  (optional)
  scores/<Nutzerschlüssel>          Punkte, ganze Zahl 0 bis 100000
  deposit/<Pfand-Typ-ID>/<Nutzerschlüssel>   Leergut-Stücke, 1 bis 100000
```

- **Nutzerschlüssel:** `"<Emoji> <Name>"` (`userKey` in `store.js`, Muster wie in den Regeln, höchstens 60 Zeichen). Es gibt keine Anmeldung: derselbe Schlüssel ist dieselbe Person.
- **Grenzen in den Regeln:** `title` 1-120 Zeichen, `amount` 1-999, `unit` bis 20, `info` bis 200, `vgNum` 1-9999999, `ean` 8-14 Ziffern, keine fremden Felder in `items`, `meta` und auf Listenebene.
- **Regeln** (`database.rules.json`, von Hand in der Firebase-Konsole veröffentlicht): außerhalb von `lists/<CODE>` alles gesperrt, Lesen mit Code offen, Schreiben auf Listenebene nur zum Löschen (`!newData.exists()`). `store.js` muss dazu passen, `test/rules.test.js` wertet die Regeln aus. Siehe [security.md](security.md) und [retention.md](retention.md).
- Die Namen der Pfand-Typen kommen aus den VG-Daten, nicht aus Firebase.

## Datenschicht (`store.js`)

`createStore(adapter)` ist einmal geschrieben und läuft gegen einen Adapter (`subscribe`, `get`, `update` als Transaktion, `set`, `remove`; Firebase zusätzlich `connect`/`disconnect`). `update`: Rückgabe `undefined` bricht ab, `null` löscht. Die Store-Methoden brechen ab, wenn der Zielzustand schon erreicht ist; deshalb sind sie wiederholbar (Grundlage der Outbox).

- `firebaseAdapter` für geteilte Listen; `localAdapter` (`localStorage`, andere Tabs über das `storage`-Ereignis) für die lokale Liste, im Demo-Modus (`firebase-config.js` ist `null`) auch für geteilte Listen, und in den Tests mit eigenem Storage-Objekt.
- Punkte (`scores`) ändert nur eine zweite Transaktion (`bump`/`point`) nach der Artikel-Transaktion, und nur wenn diese etwas geändert hat. Die Regeln dazu (wer bekommt, wer verliert den Punkt, Rückgängig, Neue Runde) stehen in AGENTS.md unter „Points“.
- Zurücksetzen: `clearOpen`, `clearChecked`, `clearAll`, `clearDeposit`, `resetScores`; welche davon laufen, bestimmt `resetPlan` in `flows.js`.
- Aktivität: die schreibenden Methoden stempeln `activity` (nicht bei schlechter Verbindung). `deleteList` entfernt die ganze Liste. `.github/workflows/cleanup.yml` führt wöchentlich `scripts/cleanup-lists.mjs` aus (Listen ohne Aktivität seit 30 Tagen, Dienstkonto-Secret `FIREBASE_SERVICE_ACCOUNT`).
- `renameUser` verschiebt Punkte, Leergut und „von“-Marken auf einen neuen Nutzerschlüssel.

## Abläufe (`app.js`)

- **Start (`init`):** `?list=<CODE>` (anders als der gespeicherte Code) tritt bei (`joinShared`), gespeicherter Code plus Name startet die geteilte Liste (`startShared`), sonst die lokale (`startLocal`). Scheitert der Start der geteilten Liste (offline), bleibt der Code gespeichert und die lokale Liste läuft. `LS` (`app.js`) speichert `me`, `code`, `numMode`, `checkoutTicks` unter `NS`.
- **Teilen:** `shareLocalList` fragt bei Bedarf Name und Emoji, legt über `uploadLocalList` (`flows.js`) eine neue Liste an und lädt Artikel und Leergut per `importList` hoch (keine Punkte); erst danach wird die lokale Kopie entfernt. Bei einem Fehler bleibt sie unverändert.
- **Beitreten:** per Link, QR-Code (Scanner im Modus `join`) oder Code (`parseListCode`); `joinShared` prüft `exists`, sonst Hinweis und zurück auf die lokale Liste.
- **Verlassen:** vergisst den Code und startet die lokale Liste; die geteilte Liste bleibt für die anderen.
- **Löschen:** `deleteList` für alle. Verschwindet eine geteilte Liste (gelöscht oder vom Aufräum-Job), meldet das `onSnapshot` (kein `meta` mehr, nur bei gesunder Verbindung, `shouldForgetList`) und die App fällt auf die lokale Liste zurück.
- **Rendern:** `state` wird bei jedem Adapter-Ereignis ersetzt und neu gerendert; wartende Outbox-Einträge liegen darüber (`outbox.overlayFor`). Tabs: Liste, Leergut, Kasse, Rangliste (nur geteilt).

## Offline und Überlast

- **Lokale Liste:** nur `localStorage`, funktioniert ohne Netz; der Firebase-SDK wird dafür nie geladen.
- **VG-Daten (`loadVg`):** erst `getChecksums.php`; stimmen die Prüfsummen mit dem Cache (`NS + 'kober-vg-v2'`) überein oder ist das Netz weg, gilt der Cache, sonst werden alle fünf Listen neu geladen und gespeichert. Zeitlimit je Anfrage 20 s. `createVgLoader` (`flows.js`) macht daraus die Zustände `loading`, `ready`, `unreachable` für den Leergut-Reiter. Details der Endpunkte: [vg-api.md](vg-api.md).
- **Service Worker:** legt die Dateien aus `FILES` beim Installieren in den Cache (`kober-v<VERSION>`, auf dev `kober-dev-v…`); gleiche Herkunft, GET: Netz zuerst, bei Fehler Cache. Firebase, VG und andere Hosts gehen daran vorbei. Bei geänderten Dateien `VERSION` in `sw.js` erhöhen.
- **Verbindung (`conn.js`):** `degraded` nach 3 s ohne Verbindung, bei Flattern oder Schreib-Timeouts; `busy` nach 15 s ohne je verbunden zu sein oder bei „verbunden und sofort getrennt“ (Verbindungslimit). Zurück auf `ok` erst nach 5 s Stabilität. Bei `busy` trennt die App selbst und versucht es mit Backoff mit Jitter erneut (bis 120 s). `guardAdapter` bricht hängende Schreibvorgänge nach 8 s ab (`PendingError`, die Operation bleibt in der Warteschlange).
- **Outbox (`outbox.js`):** Artikel- und Leergut-Operationen werden als Absicht (`{id, code, op, args, ts}`) unter `NS + 'kober-outbox'` notiert, bevor sie gesendet werden, und gestrichen, sobald sie durch sind. Bei `degraded`/`busy` wartet alles, bei `ok` und beim Start läuft `store.flush(code)` die Einträge der offenen Liste ab. Höchstens 200 Einträge, höchstens 24 h alt, jeder Eintrag wird beim Laden neu geprüft. Bewusst akzeptierte Grenzfälle stehen in AGENTS.md.
- **Cache (`cache.js`):** letzter Live-Datensatz je Liste unter `NS + 'kober-cache:' + Code` (3 Listen, je höchstens 200 KB, höchstens 30 Tage alt); wird beim ersten Laden schreibgeschützt gezeigt, bis Live-Daten kommen.
- **Testen:** `?sim=overload|slow|flap|recover:<s>|cut:<s>[:<zurück>]` (nur Demo-Modus oder dev); `test/overload.test.js` und `test/outbox.test.js` nutzen dieselbe Simulation mit manueller Uhr.

## Bauen und Veröffentlichen

- Kein Build für die App selbst: `public/` ist die Seite. Lokal `npm start` (Port 3000) oder `python3 -m http.server --directory public`; ohne Firebase-Konfiguration läuft der Demo-Modus.
- `.github/workflows/pages.yml` (Push auf `main`, manuell): `node --test`, dann `scripts/build-site.mjs` baut eine Site aus zwei Ständen: die Wurzel ist das neueste Release (Tag `v*`, bis es einen gibt `main`), `/dev/` ist `main` mit eigener Firebase-Konfiguration, eigenem Manifest-Namen und eigenen Icons. Ablauf eines Releases: AGENTS.md, „Release and dev site“.
- `.github/workflows/autofix.yml` führt dieselben Prüfungen wie lokal aus (`prek.toml`); `cleanup.yml` ist der Aufräum-Job.
- Die Datenbankregeln werden nicht mitveröffentlicht, sondern von Hand eingespielt (zuerst dev).

## Eigenes Firebase-Projekt einrichten

Nur nötig, wenn jemand die App unter eigener Adresse betreibt (kein Fork-Betrieb vorgesehen; Produktion und dev sind bereits eingerichtet).

1. In der [Firebase console](https://console.firebase.google.com) ein Projekt und eine **Realtime Database** anlegen (Region Europe).
2. *Realtime Database → Rules*: Inhalt von `database.rules.json` einfügen und veröffentlichen ([security.md](security.md#regeln-veröffentlichen)).
3. *Project settings → General → Your apps → Add app (Web)*: die Konfiguration in `public/firebase-config.js` eintragen (öffentliche Kennungen, keine Geheimnisse). Dev nutzt `public/firebase-config.dev.js`.
4. Für das Löschen nach 30 Tagen den Aufräum-Job einrichten (Secret `FIREBASE_SERVICE_ACCOUNT`, [retention.md](retention.md)).
5. GitHub: *Settings → Pages → Source: GitHub Actions*. Jeder Push auf `main` testet und veröffentlicht `public/` (`pages.yml`).

## Wo liegt was

- **Farben:** nur `public/theme.css` (Tokens, hell/dunkel); die Seiten binden die Datei ein. Kontrastgrenzen in `scripts/contrast.mjs`.
- **Texte:** nur `public/i18n.js`; Hilfeseite und Datenschutzseite sind zweisprachig und bringen ihre Texte selbst mit.
- **Tests:** `test/*.test.js`, `npm test` (`node --test`, keine Abhängigkeiten), je Modul eine Datei (Store, Regeln, VG, i18n, Flows, Outbox/Cache, Overload, Cleanup, Theme, A11y, Safari-15-Scan, Site-Build, Namensprüfung). Nicht automatisch getestet: die Oberfläche in `app.js` und der Service Worker; der echte Firebase-Adapter samt Regeln läuft in `npm run test:emulator` (siehe [security.md](security.md)); die Netzwerkaufrufe in `vg.js` wurden am 2026-11-01 einmal von Hand gegen den echten VG-Server geprüft (alle Lese-Endpunkte 200 mit CORS `*`, `loadVg()` kalt in ca. 0,3 s, danach nur Prüfsummen; eine unbekannte `shareId` liefert den Text `0`, die Entschlüsselung schlägt dann fehl); Layout prüft `npm run test:screens` (Chrome nötig).
- **Skripte:** `scripts/` (Aufräumen, Icons, Hilfe-Screenshots, Layoutprüfung, Namensabgleich, Site-Build).
