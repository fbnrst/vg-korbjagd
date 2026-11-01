# Sicherheit

Dieses Dokument beschreibt das Bedrohungsmodell, die Vertrauensgrenzen und den Betrieb der Sicherheitsmaßnahmen von Kober. Es richtet sich an den Maintainer und an Agenten, die Regeln, `store.js` oder das Rendering ändern. Meldungen von außen laufen über [SECURITY.md](../SECURITY.md); die Regeln selbst stehen in `database.rules.json`, hier steht nur, was sie bezwecken.

## Bedrohungsmodell

- Es gibt keine Anmeldung. Der **Listencode** ist das einzige Geheimnis (Capability): 6 Zeichen, bei der Erzeugung aus 32 Zeichen (32^6 ≈ 10^9), akzeptiert werden `[A-Z0-9]` (36^6 ≈ 2·10^9). Wer ihn kennt, liest, ändert und löscht die Liste. Das ist gewollt (Einkaufsliste in der Familie/WG).
- Die Wurzel ist gesperrt, Listen lassen sich nicht auflisten. Ein Code lässt sich nur durch Probieren einzelner Pfade erraten. Die Regeln haben **kein Ratenlimit**.
- Die Firebase-Web-Konfiguration (`public/firebase-config.js`) ist öffentlich und kein Geheimnis. Wer sie kennt, kann neue Listen anlegen und so Speicher und Kontingent des kostenlosen Tarifs belasten. Der wöchentliche Aufräum-Job (30 Tage ohne Aktivität, [retention.md](retention.md)) begrenzt den Speicher, verhindert die Flut aber nicht.
- Anzahl der Artikel, Nutzer und Leergut-Einträge pro Liste lässt sich in den Regeln nicht begrenzen; wer den Code kennt, kann eine Liste füllen. Abhilfe: Liste neu anlegen.

| Aktion | Mit Listencode | Nur mit Konfiguration |
|---|---|---|
| Liste lesen | ja | nein |
| Artikel, Punkte, Leergut ändern (innerhalb der Grenzen) | ja | nein |
| Liste für alle löschen | ja, gewollt | nein |
| `meta` überschreiben, Liste umbauen | nein | nein |
| Daten außerhalb der Grenzen schreiben (Markup, Riesenwerte, Fremdfelder) | nein | nein |
| Neue Listen anlegen | - | ja |

## Garantien der Regeln

Quelle der Wahrheit sind `database.rules.json` und `test/rules.test.js` (kleiner eigener Auswerter, kein echter Firebase-Interpreter). Kurzfassung:

| Knoten | Grenze |
|---|---|
| `lists/$code` | Code `^[A-Z0-9]{6}$`, `meta` Pflicht, Schreiben auf Listenebene nur als Löschen |
| `meta` | nur `created`, nur einmal beschreibbar |
| `activity` | Zahl, höchstens jetzt + 24 h |
| `items/$id` | feste Felder, Längen und Zahlbereiche, ID ≤ 40 Zeichen, keine Zusatzfelder |
| `scores`, `deposit` | ganze Zahlen (0 bzw. 1 bis 100000) |
| Nutzerschlüssel | `"<Emoji> <Name>"`, ≤ 60 Zeichen, keine Zeichen < > & " ' und Backtick |

Löschen (`null`) wird nicht validiert. Die Regeln prüfen nur neue Schreibzugriffe, nicht bereits gespeicherte Daten. `store.js` validiert spiegelbildlich (`isUserKey`, `userKey()`, `isId`), damit legitime Clients nie Daten schreiben, die abgelehnt würden; beides muss zusammen geändert werden.

## Vertrauensgrenzen

- **Nicht vertrauenswürdig:** alles aus der Datenbank, aus `localStorage` (der Nutzer kann es beschreiben, auch Outbox `NS + 'kober-outbox'` und Cache `NS + 'kober-cache:<code>'`; beide werden beim Laden validiert) sowie Produktdaten von VG und Open Food Facts.
- **Escaping ist Pflicht:** Jeder dieser Werte geht mit `esc()` in HTML. Nutzerschlüssel entstehen über `userKey()`. Die Regeln sind die zweite Schicht, das Escaping die eigentliche Absicherung (die Regeln wirken nicht auf Altdaten).
- **Invariante:** `esc()` (`public/app.js`) maskiert `& < > "`, **nicht** `'`. Attribute müssen deshalb immer in doppelten Anführungszeichen stehen. Ein automatischer Test dafür wurde nicht ergänzt, weil er sich nicht zuverlässig schreiben lässt (Template-Strings, verschachtelte Aufrufe); bei Änderungen am Rendering per Review prüfen.

## Dritte, Datenfluss und Browser

- Verbindungen gehen zu Firebase (SDK von gstatic.com, `store.js`), zu den VG-Endpunkten (`vg.js`), zu Open Food Facts (`app.js`, nur beim Scannen unbekannter Codes). zxing (Scanner auf iPhones) liegt seit November 2026 in `public/vendor/`, es gibt kein CDN mehr. Alles ist in `public/privacy.html` aufgeführt.
- **Content-Security-Policy** als `<meta>` in allen drei Seiten (GitHub Pages setzt keine Header): Skripte nur von der eigenen Seite, `gstatic.com` (Firebase-SDK) und `*.firebasedatabase.app` (Long-Polling-Fallback der Datenbank, dafür auch `frame-src`), keine Inline-Skripte (Hilfe- und Datenschutzseite haben dafür `docs/help.js` und `privacy.js`), `connect-src` nur Firebase, VG und Open Food Facts. Sie ist die zweite Schicht hinter `esc()`. `test/csp.test.js` prüft die Richtlinie gegen die Hosts im Code; wer einen neuen Host anspricht, muss ihn in `public/index.html` ergänzen. `frame-ancestors` geht per `<meta>` nicht.
- Der Listencode steckt im Link `?list=CODE`. Alle drei Seiten setzen `<meta name="referrer" content="no-referrer">` (`test/referrer.test.js`), damit er nicht in Anfragen an Dritte mitgeht.
- Release und `/dev/` teilen sich einen Ursprung. Das Präfix `NS` trennt `localStorage` und Service-Worker-Caches; jeder neue Schlüssel muss es benutzen. Dev hat ein eigenes Firebase-Projekt (`public/firebase-config.dev.js`).
- `?sim=` (simulierter Server) wirkt nur im Demo-Modus oder auf der Dev-Seite, nie auf dem Release mit echter Datenbank.

## Geheimnisse und Lieferkette

- Das Dienstkonto in `FIREBASE_SERVICE_ACCOUNT` umgeht die Regeln und kann alles lesen und löschen. Es liegt nur als GitHub-Secret vor, sollte nur die Rolle *Firebase Realtime Database Admin* haben ([retention.md](retention.md)) und wird bei Verdacht in der Cloud-Konsole widerrufen. Der Aufräum-Job läuft nur für das Produktionsprojekt, nicht für Dev.
- Dependabot schlägt wöchentlich neue Versionen der GitHub Actions vor. prek-Hooks laufen lokal und in CI; gitleaks scannt absichtlich nur gestagte Änderungen, in CI findet es daher nichts.
- Alle Actions sind auf Commit-Hashes festgelegt (Versions-Tag als Kommentar, Dependabot aktualisiert beides). In `cleanup.yml` bekommen nur die zwei Schritte, die es brauchen, das Secret `FIREBASE_SERVICE_ACCOUNT`, nicht die Fremd-Actions; `checkout` läuft dort ohne gespeicherten Token.
- Listencodes kommen aus `crypto.getRandomValues` (`store.js`), nicht aus `Math.random`.
- `public/vendor/` (crypto-js, qrcode, zxing) ist von den Prüfungen ausgenommen. zxing ist byte-gleich mit `umd/index.min.js` aus dem npm-Paket `@zxing/library@0.21.3`; ein Update ersetzt die Datei aus dem npm-Paket und vergleicht den Hash.

## Regeln veröffentlichen

Die Regeln werden von Hand eingespielt, **zuerst Dev, dann Produktion** (Projekte `vg-korbjagd-dev` und `vg-korbjagd`; die Ids behalten den alten Namen Korbjagd).

1. Firebase console → Projekt → **Realtime Database** → Tab **Rules**.
2. Inhalt von `database.rules.json` einfügen.
3. In **Rules Playground** prüfen: Schreiben auf `lists/ABC234/items/a1`, `meta`, `activity` (erlaubt), Löschen von `lists/ABC234` (erlaubt), Überschreiben von `lists/ABC234` mit Daten (abgelehnt).
4. **Publish**, dann in der App eine Liste anlegen, beitreten, Artikel anlegen/abhaken/löschen.

## Offene Punkte

- **Tarif:** Das Produktionsprojekt läuft auf dem kostenlosen **Spark**-Tarif (bestätigt vom Maintainer). Damit können keine Kosten entstehen; bei überschrittenem Kontingent (u. a. etwa 100 gleichzeitige Verbindungen) wird der Dienst gedrosselt oder gestoppt. **Budgetalarme** gibt es nur beim Blaze-Tarif und sind hier nicht nötig. Die App fängt das ab (Verbindungsbanner, Outbox, Cache, siehe [architecture.md](architecture.md)).
- **App Check:** Status unbekannt (Firebase console: *Build → App Check*, Reiter *Apps* und *APIs*). Für eine Familien-Einkaufsliste nicht empfohlen und nicht geplant: es braucht reCAPTCHA und könnte bei falscher Einstellung die App aussperren; der Listencode bleibt der Zugriffsschutz.
- Kein Ratenlimit und keine Begrenzung der Knotenanzahl in den Regeln (siehe oben).
