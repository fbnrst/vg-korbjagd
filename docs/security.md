# Sicherheit der Datenschicht

Stand der Prüfung: `database.rules.json`, `public/store.js`, Rendering in `public/app.js`, Aufräum-Job `scripts/cleanup-lists.mjs` (zuletzt abgeglichen im Oktober 2026).

## Bedrohungsmodell

- Die Firebase-Web-Konfiguration (`public/firebase-config.js`) ist öffentlich und **kein Geheimnis**. Wer die Seite öffnet, kennt sie.
- Es gibt keine Anmeldung. Der **Listencode** (6 Zeichen aus A–Z/0–9) ist das einzige Geheimnis: Wer ihn kennt, darf die Liste lesen und ändern. Das ist so gewollt (Einkaufsliste in der Familie/WG).
- Die Wurzel ist gesperrt (`.read`/`.write` = false), Listen lassen sich nicht auflisten. Einen Code zu erraten ist theoretisch möglich (32^6 ≈ 10^9 bei der Erzeugung, 36^6 ≈ 2·10^9 Muster insgesamt), aber nur durch gezieltes Probieren einzelner Pfade.

### Was jemand mit Code oder Konfiguration trotzdem kann

| Angriff | Mit Code | Nur mit Konfiguration |
|---|---|---|
| Liste lesen | ja | nein |
| Artikel anlegen/ändern/löschen, abhaken | ja | nein |
| Scores/Leergut verändern (innerhalb 0–100000) | ja | nein |
| Ganze Liste für alle löschen („Liste für alle löschen“) | **ja**, gewollt (Regeln erlauben nur das Löschen auf Listenebene) | nein |
| `meta` überschreiben | **nein** (Regeln) | nein |
| Fremde Daten/XSS/Riesenwerte einschleusen | **nein** (Regeln) | nein |
| Neue Listen anlegen (Flut) | – | **ja** |
| Viele Artikel in eine bekannte Liste schreiben | ja | nein |

## Was die Regeln erzwingen

- `lists/$code`: Code muss `^[A-Z0-9]{6}$` sein, `meta` muss vorhanden sein, keine unbekannten Kindknoten. Auf Listenebene ist **nur Löschen** erlaubt (`.write`: `!newData.exists()`), also nichts überschreiben oder umbauen; das trägt die Funktion „Liste für alle löschen“ (`store.deleteList`). Sonst gibt es Schreibrecht nur an `items`, `scores`, `deposit`, `activity` und (nur Anlegen) `meta`.
- `meta`: nur `created` (Zahl), nur beschreibbar solange es nicht existiert. Der Besitz-Marker kann nicht überschrieben werden.
- `items/$id`: ID `[A-Za-z0-9_-]{1,40}` und gleich dem Feld `id`; Pflicht `id,title,amount,checked,addedBy,addedAt`; `title` 1–120 Zeichen, `amount` ganze Zahl 1–999, `unit` ≤ 20, `info` ≤ 200, `vgNum` ganze Zahl 1–9999999, `ean` 8–14 Ziffern, `checked` boolean, Zeitstempel Zahlen, `checkedBy`/`addedBy` gültige Nutzerschlüssel, keine Zusatzfelder.
- `activity`: Zahl > 0, höchstens 24 Stunden in der Zukunft (`now + 86400000`). Der Zeitstempel der letzten Aktivität bestimmt, wann der Aufräum-Job die Liste löscht (30 Tage, siehe [retention.md](retention.md)).
- `scores/$user`: ganze Zahl 0–100000. `deposit/$typ/$user`: ganze Zahl 1–100000, `$typ` `[A-Za-z0-9_-]{1,20}`.
- **Nutzerschlüssel** `"<Emoji> <Name>"`: höchstens 60 Zeichen, Emoji-Teil ohne Leerzeichen, keine Zeichen `< > & " ' \``. Das schließt XSS über Schlüssel aus (siehe unten).
- `null`/Löschen (Transaktionen, `remove`) wird nicht validiert und bleibt erlaubt; das von `store.js` benutzte `remove` ganzer Knoten (`deposit`, `items/<id>`) funktioniert, weil dort Schreibrecht besteht.

`store.js` validiert spiegelbildlich (`userKey` ersetzt Sonderzeichen, `isUserKey`/`isId`, `vgNum` wird zu ganzer Zahl oder `null`, Punktestand gedeckelt), damit legitime Clients nie Daten schreiben, die die Regeln ablehnen würden.

## Befunde

**Hoch (behoben)**
- *Gespeichertes XSS über Nutzerschlüssel und IDs.* Früher renderte `app.js` Emoji-Teil, Item-IDs, Mengen und VG-Nummern teils ohne `esc()`. Ein Fremder mit Listencode hätte z. B. `scores/<svg/onload=…> x` oder eine Item-ID `"><img onerror=…>` schreiben können, das lief dann bei allen Mitgliedern. Zwei Schichten verhindern das jetzt: Die Regeln lassen solche Schlüssel und Nicht-Zahlen nicht mehr zu, und `app.js` gibt **alles** aus der Datenbank mit `esc()` aus (Titel, Namen, Emoji, IDs, Mengen, Einheiten, VG-Nummern, importierte VG-Listen). Die Regeln wirken nur nach dem Einspielen und nicht auf bereits gespeicherte Daten, deshalb ist das Escaping die eigentliche Absicherung. `esc` maskiert `'` nicht; das ist unkritisch, solange alle Attribute in `"` stehen.

**Mittel**
- *Überschreiben von `meta` oder Umbauen einer Liste auf Listenebene* war möglich; jetzt nicht mehr. **Restrisiko:** Das Löschen der ganzen Liste ist für jeden mit Code möglich, weil „Liste für alle löschen“ es braucht. Ein Fremder mit Code kann also eine Liste löschen; Mitglieder legen sie neu an. Akzeptiert, weil der Code das einzige Geheimnis der Liste ist.
- *Riesige Werte/Datenmüll* (beliebig lange Strings, Fremdfelder) waren möglich; jetzt begrenzt.
- *Score-Manipulation*: bleibt möglich (offene Schreibrechte), aber nur im Wertebereich 0–100000. Das ist eine Spielerei, kein Schaden.

**Niedrig / Restrisiko**
- Anzahl Artikel pro Liste und Anzahl Nutzer/Leergut-Einträge sind in den Regeln **nicht begrenzbar** (kein `numChildren` in Regeln). Wer den Code kennt, kann eine Liste mit vielen kleinen Einträgen füllen (je ≤ ~600 Byte). Abhilfe: Liste neu anlegen.
- *Listen-Flut*: Wer die öffentliche Konfiguration kennt, kann beliebig viele Listen mit `meta` anlegen. Der Aufräum-Job löscht Listen nach 30 Tagen ohne Aktivität (`scripts/cleanup-lists.mjs`, wöchentlich), das begrenzt den Speicher, verhindert die Flut aber nicht. Weitere Gegenmittel (nicht im Repo möglich): Firebase **App Check** aktivieren und in der Cloud-Konsole **Budget-/Nutzungsalarme** setzen.
- *Aufräum-Job*: Der Dienstkonto-Schlüssel im GitHub-Secret `FIREBASE_SERVICE_ACCOUNT` umgeht die Regeln und kann alle Daten lesen und löschen. Er liegt nur als Secret vor (nie im Repo), hat nur den Zweck Aufräumen und wird bei Verdacht in der Cloud-Konsole widerrufen.
- Eine ungültige Teilmenge eines Mehrfach-Updates wird von Firebase atomar abgelehnt; die App zeigt dann keinen Fehler. Das betrifft nur manipulierte Clients.
- Bereits gespeicherte Altdaten werden von den Regeln nicht geprüft, nur neue Schreibzugriffe.
- Nutzer mit einem Namen aus früheren Versionen, der verbotene Zeichen enthielt (`<>&"'`), bekommen jetzt einen anderen Schlüssel (Zeichen werden durch `_` ersetzt) und starten bei 0 Punkten.

## Tests

`npm test` führt unter anderem aus:

- `test/rules.test.js`: liest `database.rules.json` und prüft mit einem kleinen eigenen Auswerter (nur die in den Regeln benutzte Teilmenge: `isString`, `isNumber`, `isBoolean`, `hasChildren`, `matches`, `val()`, `length`, `%`) die Struktur sowie gültige und manipulierte Dokumente, außerdem den kompletten Ablauf von `store.js`.
- `test/store.test.js`: Validierung in `store.js`.

**Nicht prüfbar ohne Firebase:** Der Auswerter ist kein echter Regel-Interpreter; Besonderheiten der Firebase-Regelsprache (Auswertung von `.write` entlang des Pfads, Verhalten von `.validate` bei Mehrpfad-Updates, Regex-Dialekt) sind nicht abgedeckt. Vor dem Veröffentlichen die Regeln im **Regel-Simulator** der Konsole (Tab „Regeln“ → „Regel-Playground“) gegen ein `set` auf `lists/ABC234/items/a1`, `lists/ABC234/meta`, `lists/ABC234/activity` und einen Löschversuch auf `lists/ABC234` (muss erlaubt sein) sowie ein Überschreiben von `lists/ABC234` mit Daten (muss abgelehnt werden) prüfen, oder lokal mit dem Emulator (`npx firebase-tools emulators:start --only database`, braucht `firebase-tools`; wurde hier nicht installiert).

## Regeln in der Firebase-Konsole einspielen

1. Firebase-Konsole → Projekt `vg-korbjagd` → **Realtime Database** → Tab **Regeln**.
2. Kompletten Inhalt von `database.rules.json` einfügen (ersetzt die alten Regeln).
3. Im Regel-Playground die drei Fälle oben simulieren, dann **Veröffentlichen**.
4. Danach in der App prüfen: neue Liste anlegen, beitreten, Artikel hinzufügen/abhaken/löschen, Leergut, Rangliste zurücksetzen.

Alternativ mit der CLI: `firebase deploy --only database` (setzt `firebase.json` mit `"database": {"rules": "database.rules.json"}` voraus).
