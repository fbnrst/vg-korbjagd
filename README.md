# vg-korbjagd – gemeinsame Einkaufsliste mit Rangliste

Eine unabhängige, inoffizielle Einkaufslisten-App mit Live-Sync zwischen Handys und einer Rangliste („wer hat am meisten in den Korb gelegt“). Idee und Datengrundlage: die [VG-App](https://gitlab.com/pyfox/vg-app) der VG Dresden; mit der VG Dresden ist dieses Projekt nicht verbunden.

## Start
    npm start            # http://localhost:3000  (PORT=… DATA=… möglich)
    npm test

Auf dem Handy im selben WLAN: `http://<IP-des-Rechners>:3000`. Zum Installieren als App (PWA) ist HTTPS nötig, also auf einen kleinen Server/Hoster legen.

## Benutzung
1. Name + Emoji wählen, „Neue Liste starten“.
2. „Teilen“ schickt den Link/Code (`/?list=ABC123`) an die anderen Handys.
3. Artikel eintippen (reine Zahl = VG-Nummer). Abhaken oder VG-Nummer eintragen legt den Artikel in den Korb – alle sehen es sofort, mit Namen des Abhakers.
4. Tab „Rangliste“: Punkte pro Artikel im Korb, „Neue Runde“ setzt zurück.

Technik: Node-Server ohne Abhängigkeiten, Server-Sent-Events, Zustand in `data.json`; Offline-Aktionen werden nachgesendet.
Barcode: 📷 neben dem Eingabefeld. Bekannter Artikel (gleicher Code oder Name) wird abgehakt, sonst neu angelegt (Name via Open Food Facts) und abgehakt. Kamera braucht HTTPS (oder localhost). Chrome/Android nutzt BarcodeDetector, Safari lädt zxing von jsDelivr nach.
Nicht enthalten: VG-Produktdatenbank, Pfand. Die VG-Endpunkte sind in [docs/vg-api.md](docs/vg-api.md) beschrieben.

## Lizenz

BSD 3-Clause, siehe [LICENSE](LICENSE). Die VG-Daten (siehe `docs/vg-api.md`) gehören der VG Dresden und sind nicht Teil dieser Lizenz.
