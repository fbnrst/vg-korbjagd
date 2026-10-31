# vg-korbjagd – gemeinsame Einkaufsliste mit Rangliste

Eine unabhängige, inoffizielle Einkaufslisten-App mit Live-Sync zwischen Handys und einer Rangliste („wer hat am meisten in den Korb gelegt“). Idee und Datengrundlage: die [VG-App](https://gitlab.com/pyfox/vg-app) der VG Dresden; mit der VG Dresden ist dieses Projekt nicht verbunden.

Kein eigener Server nötig: statische Seite (GitHub Pages) + Firebase Realtime Database (Gratis-Stufe).

## Benutzung
1. Name + Emoji wählen, „Neue Liste starten“.
2. „Teilen“ zeigt einen QR-Code zum Scannen (plus Code und „Link senden“ als Alternative).
3. Artikel eintippen (reine Zahl = VG-Nummer) oder per 📷 Barcode scannen. Abhaken oder VG-Nummer eintragen legt den Artikel in den Korb, alle sehen es sofort mit dem Namen des Abhakers.
4. Tab „Rangliste“: Punkte pro Artikel im Korb, „Neue Runde“ setzt zurück.

Scanner: bekannter Artikel (gleicher Code oder Name) wird abgehakt, sonst neu angelegt (Name via Open Food Facts) und abgehakt. Kamera braucht HTTPS (GitHub Pages) oder localhost. Chrome/Android nutzt BarcodeDetector, Safari lädt zxing von jsDelivr nach.

## Lokal ausprobieren (Demo-Modus)
    npm start      # http://localhost:3000
    npm test

Ohne Firebase-Konfiguration läuft die App im Demo-Modus: Daten nur im Browser, Tabs im selben Browser synchronisieren sich. Zum Testen mit mehreren Handys braucht es Firebase.

## Einrichtung mit Firebase (einmalig, kostenlos)
1. In der [Firebase-Konsole](https://console.firebase.google.com) ein Projekt anlegen, dort **Realtime Database** erstellen (Region Europa).
2. Unter *Realtime Database → Regeln* den Inhalt von `database.rules.json` einfügen und veröffentlichen. Listen sind nur über ihren 6-stelligen Code erreichbar und nicht auflistbar; wer den Code kennt, kann lesen und schreiben.
3. Unter *Projekteinstellungen → Allgemein → Web-App hinzufügen* die Konfiguration kopieren und in `public/firebase-config.js` eintragen (öffentliche Kennungen, keine Geheimnisse).
4. Auf GitHub unter *Settings → Pages → Source: GitHub Actions* stellen. Jeder Push auf `main` testet und veröffentlicht `public/` (`.github/workflows/pages.yml`).

Technik: Listenlogik in `public/store.js` (Firebase- und lokaler Adapter), Oberfläche in `public/app.js`. Abhaken läuft als Transaktion, damit zwei gleichzeitige Klicks nur einen Punkt geben. Firebase puffert Aktionen offline und sendet sie nach.

**VG-Nummern:** Die App lädt die VG-Stammdaten direkt vom VG-Server und erkennt Nummern (Eingabe oder Nr.-Feld an einem Artikel): Titel, Einheit, Hersteller und Land werden eingetragen, beim Tippen gibt es Vorschläge. **Import:** Teilen-Link aus der Original-VG-App im Knopf „📥 VG-App“ (oder im Eingabefeld) einfügen, die Artikel kommen offen in die Liste. Details und Endpunkte: [docs/vg-api.md](docs/vg-api.md).

Nicht enthalten: Pfand.

## Lizenz

BSD 3-Clause, siehe [LICENSE](LICENSE). Die VG-Daten (siehe `docs/vg-api.md`) gehören der VG Dresden und sind nicht Teil dieser Lizenz.

Enthaltene Fremdsoftware (MIT, Hinweise in den Dateiköpfen): `public/vendor/qrcode.js` (qrcode-generator 1.4.4), `public/vendor/crypto-js.js` (CryptoJS 4.2.0).
