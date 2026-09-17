# Login-Hilfsskript

Ein eigenstaendiges Tool, das **nicht** auf dem ioBroker-Host laufen muss
(der ist meist headless - Raspberry Pi, NAS, Docker). Fuehre es stattdessen
auf einem beliebigen PC/Mac mit echtem Browser aus, z. B. deinem
Desktop-Rechner. Es bleibt komplett lokal: nichts wird an einen Server
hochgeladen, auch nicht an den Adapter-Autor.

## Fuer Endnutzer: fertiges Programm herunterladen

Kein Node.js, kein Terminal noetig. Lade die passende Datei von der
[Releases-Seite](https://github.com/beabel/ioBroker.googlefindmydevice/releases)
herunter (`login-helper-win.exe` fuer Windows, entsprechend fuer macOS/Linux)
und starte sie per Doppelklick. Ein Konsolenfenster oeffnet sich, fragt nach
deiner Google-Kontoadresse und oeffnet danach ein echtes Chrome-Fenster fuer
den Login. Beim allerersten Start laedt es sich selbst eine eigene
Chrome-Kopie herunter (~200 MB, nur einmalig, braucht Internet).

Am Ende zeigt das Fenster einen Textblock an. Behandle ihn wie ein Passwort
(er gewaehrt Lesezugriff auf deine Tracker-Standorte) und trage ihn in die
Konfiguration des ioBroker-Adapters ein, sobald diese verfuegbar ist.

## Fuer Entwickler: aus dem Quellcode ausfuehren/bauen

```bash
cd tools/login-helper
npm install
npm start          # direkt ausfuehren
npm run build       # baut Windows-/macOS-/Linux-Executables nach dist/
```

`npm run build` bündelt zuerst mit esbuild (damit alle Abhaengigkeiten,
inklusive Puppeteer, in einer Datei landen) und packt das Ergebnis dann mit
`pkg` zu eigenstaendigen Executables. Wenn sich die Module in `../../lib`
(dem Haupt-Adapter) aendern, `npm run prebuild` (bzw. einfach `npm install`
erneut) ausfuehren, damit die lokale Kopie in `node_modules` aktuell bleibt.

## Status

Aktuell nur Schritt 1 (Google-Login -> langlebiges Konto-Token). Schritt 2
(Freigabe des Standort-Entschluesselungsschluessels ueber eine zweite,
Google-eigene Seite) folgt in einer spaeteren Version.
