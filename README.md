# vg-korbjagd – gemeinsame Einkaufsliste mit Rangliste

[![Checks](https://github.com/fbnrst/vg-korbjagd/actions/workflows/checks.yml/badge.svg)](https://github.com/fbnrst/vg-korbjagd/actions/workflows/checks.yml)
[![Deploy](https://github.com/fbnrst/vg-korbjagd/actions/workflows/pages.yml/badge.svg)](https://github.com/fbnrst/vg-korbjagd/actions/workflows/pages.yml)

**App: <https://fbnrst.github.io/vg-korbjagd/>** · [Hilfe](https://fbnrst.github.io/vg-korbjagd/docs/) · [Datenschutz](https://fbnrst.github.io/vg-korbjagd/privacy.html)

Eine unabhängige, inoffizielle Einkaufslisten-App: Die Liste liegt zuerst nur auf dem Handy, beim Teilen gibt es Live-Sync zwischen Handys und eine Rangliste („wer hat am meisten in den Korb gelegt“). Idee und Datengrundlage: die [VG-App](https://gitlab.com/pyfox/vg-app) der VG Dresden; mit der VG Dresden ist dieses Projekt nicht verbunden.

Kein eigener Server nötig: statische Seite (GitHub Pages) + Firebase Realtime Database (Gratis-Stufe).

## Funktionen
- Die Liste liegt zuerst lokal auf dem Handy (ohne Konto, auch offline); erst beim Teilen läuft sie über den Server, mit Live-Sync, Beitritt per QR-Code oder 6-stelligem Code, und das Spiel startet
- Oberfläche in der Systemsprache (Deutsch oder Englisch)
- Artikel per Text, VG-Nummer (mit Produkterkennung aus den VG-Stammdaten) oder Barcode-Scanner (Open Food Facts)
- Import von Listen der Original-VG-App (Teilen-Link)
- Abhaken legt Artikel in den Korb, alle sehen, wer es war
- Reiter Leergut (Pfand-Stücke zählen), Kasse (Artikel mit VG-Nummern, Bildschirm bleibt an) und Rangliste (Punkte fürs Abhaken und pro Leergut-Stück, „Neue Runde“)
- Installierbar als PWA; Demo-Modus ohne Firebase

Dokumentation: [Hilfeseite in der App](https://fbnrst.github.io/vg-korbjagd/docs/) · [Datenschutzhinweise](public/privacy.html) · [Anleitung für Eltern und Kinder](docs/anleitung.md) · [Architektur](docs/architecture.md) · [VG-Endpunkte](docs/vg-api.md)

## Lokal ausprobieren (Demo-Modus)
    npm start      # http://localhost:3000
    npm test

Ohne Firebase-Konfiguration läuft die App im Demo-Modus: Daten nur im Browser, Tabs im selben Browser synchronisieren sich. Zum Testen mit mehreren Handys braucht es Firebase.

## Einrichtung mit Firebase (einmalig, kostenlos)
1. In der [Firebase-Konsole](https://console.firebase.google.com) ein Projekt anlegen, dort **Realtime Database** erstellen (Region Europa).
2. Unter *Realtime Database → Regeln* den Inhalt von `database.rules.json` einfügen und veröffentlichen. Listen sind nur über ihren 6-stelligen Code erreichbar und nicht auflistbar; wer den Code kennt, kann lesen und schreiben.
3. Unter *Projekteinstellungen → Allgemein → Web-App hinzufügen* die Konfiguration kopieren und in `public/firebase-config.js` eintragen (öffentliche Kennungen, keine Geheimnisse).
4. Auf GitHub unter *Settings → Pages → Source: GitHub Actions* stellen. Jeder Push auf `main` testet und veröffentlicht `public/` (`.github/workflows/pages.yml`).

Technik, Datenmodell und Offline-Verhalten: [docs/architecture.md](docs/architecture.md). Die VG-Daten werden direkt vom VG-Server geladen, Endpunkte in [docs/vg-api.md](docs/vg-api.md).

## Entwicklung

Konventionen für Menschen und Agenten stehen in [AGENTS.md](AGENTS.md): Quelltext und Kommentare sind englisch, die Oberfläche folgt der Systemsprache.

Code-Checks laufen lokal als Git-Hook über [prek](https://github.com/j178/prek) (Konfiguration: `.pre-commit-config.yaml`): Dateihygiene, JSON/YAML, JavaScript-Syntax, Tests und gitleaks (Geheimnisse; die öffentliche Firebase-Konfiguration ist in `.gitleaks.toml` freigegeben). Einmalig `prek install`, manuell `prek run --all-files`. Dieselben Prüfungen laufen in GitHub Actions (`.github/workflows/checks.yml`), dort scannt gitleaks zusätzlich die ganze Historie.

## Lizenz

BSD 3-Clause, siehe [LICENSE](LICENSE). Die VG-Daten (siehe `docs/vg-api.md`) gehören der VG Dresden und sind nicht Teil dieser Lizenz.

Enthaltene Fremdsoftware (MIT, Hinweise in den Dateiköpfen): `public/vendor/qrcode.js` (qrcode-generator 1.4.4), `public/vendor/crypto-js.js` (CryptoJS 4.2.0).
