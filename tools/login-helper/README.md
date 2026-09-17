# Login-Hilfsskript

Ein eigenstaendiges Tool, das **nicht** auf dem ioBroker-Host laufen muss
(der ist meist headless - Raspberry Pi, NAS, Docker). Fuehre es stattdessen
auf einem beliebigen PC/Mac aus, z. B. deinem Desktop-Rechner. Es bleibt
komplett lokal: nichts wird an einen Server hochgeladen, auch nicht an den
Adapter-Autor. Es steuert **keinen** Browser fern - du meldest dich ganz
normal in deinem eigenen Browser an, das Tool liest danach nur einen Wert
aus, den du selbst kopierst.

## Fuer Endnutzer: fertiges Programm herunterladen

Kein Node.js, kein Terminal noetig. Lade die passende Datei von der
[Releases-Seite](https://github.com/beabel/ioBroker.googlefindmydevice/releases)
herunter (`login-helper-win.exe` fuer Windows, entsprechend fuer macOS/Linux)
und starte sie per Doppelklick. Ein Fenster mit einer Anleitung oeffnet sich:

1. Du oeffnest `https://accounts.google.com/EmbeddedSetup` in deinem eigenen
   Browser (Chrome/Edge) und meldest dich dort ganz normal mit dem
   Google-Konto an, mit dem deine Tracker verknuepft sind.
2. Du oeffnest die Entwicklertools (Taste `F12`) → Reiter "Anwendung"
   ("Application") → "Cookies" → `https://accounts.google.com`.
3. Du kopierst den Wert der Zeile `oauth_token`.
4. Du fuegst diesen Wert im Fenster des Login-Hilfsskripts ein und druesckst
   Enter.

Das Tool tauscht diesen Wert danach direkt bei Google gegen ein langlebiges
Konto-Token und zeigt zur Kontrolle gleich deine gefundenen Tracker an.

Am Ende zeigt das Fenster einen Textblock (JSON) an. Behandle ihn wie ein
Passwort (er gewaehrt Lesezugriff auf deine Tracker-Standorte) und trage ihn
in die Konfiguration des ioBroker-Adapters ein, sobald diese verfuegbar ist.

**Wichtig:** der `oauth_token`-Cookie-Wert ist nur kurz gueltig. Schritte 1-3
direkt vor dem Einfuegen in Schritt 4 durchfuehren, nicht vorher kopieren und
liegen lassen.

## Fuer Entwickler: aus dem Quellcode ausfuehren/bauen

```bash
cd tools/login-helper
npm install
npm start          # direkt ausfuehren
npm run build       # baut Windows-/macOS-/Linux-Executables nach dist/
```

`npm run build` bündelt zuerst mit esbuild (damit alle Abhaengigkeiten in
einer Datei landen) und packt das Ergebnis dann mit `pkg` zu eigenstaendigen
Executables. Wenn sich die Module in `../../lib` (dem Haupt-Adapter) aendern,
`npm run prebuild` (bzw. einfach `npm install` erneut) ausfuehren, damit die
lokale Kopie in `node_modules` aktuell bleibt.

## Warum keine Browser-Automatisierung?

Eine fruehere Version dieses Tools hat versucht, den Login-Browser selbst zu
steuern (per Puppeteer). Google erkennt automatisierte Chrome-Instanzen aber
zuverlaessig und blockiert den Login dann mit "Dieser Browser oder App ist
unsicher". Der zuverlaessige Workaround dafuer (Bot-Erkennung gezielt
umgehen) ist ein Werkzeug, das wir bewusst nicht einsetzen wollen. Die
Copy-Paste-Loesung oben braucht dafuer keinerlei Trickserei, weil du dich
in einem ganz normalen, von dir selbst bedienten Browser anmeldest.

## Status

Aktuell nur Schritt 1 (Google-Login -> langlebiges Konto-Token, inkl.
Testabruf der Geraeteliste). Schritt 2 (Freigabe des
Standort-Entschluesselungsschluessels ueber eine zweite, Google-eigene
Seite) folgt in einer spaeteren Version - dafuer wird noch ermittelt, ob
eine aehnliche Copy-Paste-Loesung ohne Automatisierung moeglich ist.
