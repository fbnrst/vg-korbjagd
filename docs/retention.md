# Aufbewahrung und Löschen von Listen

## Was passiert wann

- **Selbst löschen:** In der App unter *Teilen → Liste für alle löschen*. Das entfernt die geteilte Liste endgültig für alle Mitglieder (`store.deleteList`). Wer die Liste noch offen hat, landet automatisch wieder auf seiner lokalen Liste.
- **Automatisch nach einem Jahr:** Die App schreibt beim Öffnen und Ändern einer geteilten Liste einen Zeitstempel `lists/<CODE>/activity` (höchstens einmal pro Stunde). Der Workflow `.github/workflows/cleanup.yml` läuft jede Woche und löscht Listen, deren letzte Aktivität (oder Erstellung, falls es keinen Stempel gibt) älter als 365 Tage ist. Der Abgleich steckt in `scripts/cleanup-lists.mjs` und ist getestet (`test/cleanup.test.js`).
- Lokale Listen liegen nur auf dem Handy und werden nie vom Server gelöscht.

## Einrichtung (einmalig, nur du kannst das)

Der Aufräum-Job braucht Admin-Zugriff auf die Datenbank, weil die Regeln das Auflisten und Löschen fremder Listen bewusst nicht erlauben.

1. Firebase-Konsole → Projekt `vg-korbjagd` → ⚙ *Projekteinstellungen* → *Dienstkonten* → **Neuen privaten Schlüssel generieren**. Die JSON-Datei nirgends einchecken.
   - Sparsamer als das Standard-Dienstkonto: in der Google-Cloud-Konsole (IAM) ein eigenes Dienstkonto mit nur der Rolle *Firebase Realtime Database Admin* anlegen und dessen Schlüssel verwenden.
2. GitHub → Repository → *Settings → Secrets and variables → Actions → New repository secret*: Name `FIREBASE_SERVICE_ACCOUNT`, Wert ist der **komplette Inhalt** der JSON-Datei. Danach die Datei löschen.
3. Neue Regeln einspielen: `database.rules.json` unter *Realtime Database → Regeln* veröffentlichen (enthalten sind jetzt `activity` und das Löschen ganzer Listen). Vorher im Regel-Playground prüfen, siehe `docs/security.md`.
4. Testlauf: GitHub → *Actions → Cleanup old lists → Run workflow* mit **dry run** (Voreinstellung): Das Protokoll zeigt, welche Listen gelöscht würden, ohne etwas zu löschen. Danach läuft der Job wöchentlich von selbst.

Solange das Secret fehlt, **schlägt der Workflow absichtlich fehl** (rotes Badge, E-Mail von GitHub), weil die Datenschutzhinweise eine automatische Löschung versprechen.

## Hinweise

- Das Skript löscht nie Listen ohne Zeitstempel (unbekanntes Alter) und verlangt mindestens 30 Tage als Frist (`MAX_AGE_DAYS`).
- Die Frist ist in `cleanup.yml` (`MAX_AGE_DAYS`) und in den Datenschutzhinweisen (`public/privacy.html`, „12 Monate“) festgehalten; beides gemeinsam ändern.
- Wer einen Listencode kennt, kann die Liste löschen (so wie er sie auch leeren könnte). Die App fragt vorher nach.
