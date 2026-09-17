# Login-Hilfsskript

Ein eigenstaendiges Node.js-Tool, das **nicht** auf dem ioBroker-Host laufen
muss (der ist meist headless - Raspberry Pi, NAS, Docker). Fuehre es
stattdessen auf einem beliebigen PC/Mac mit echtem Browser aus, z. B. deinem
Desktop-Rechner. Es bleibt komplett lokal: nichts wird an einen Server
hochgeladen, auch nicht an den Adapter-Autor.

## Voraussetzung

[Node.js](https://nodejs.org/) (Version 18 oder neuer) auf dem Rechner, auf
dem du das Skript ausfuehrst.

## Benutzung

```bash
cd tools/login-helper
npm install
npm start
```

Es oeffnet sich ein echtes Chrome-Fenster. Melde dich darin ganz normal mit
dem Google-Konto an, mit dem deine Find-Hub-Tracker verknuepft sind
(inklusive Zwei-Faktor-Bestaetigung, falls aktiv). Dieses Skript sieht dein
Passwort nicht - es liest nur ein kurzlebiges Cookie, nachdem der Login
abgeschlossen ist, und tauscht es direkt bei Google gegen ein langlebiges
Token.

Am Ende gibt das Skript einen JSON-Block aus. Behandle ihn wie ein Passwort
(er gewaehrt Lesezugriff auf deine Tracker-Standorte) und trage ihn in die
Konfiguration des ioBroker-Adapters ein, sobald diese verfuegbar ist.

## Status

Aktuell nur Schritt 1 (Google-Login -> langlebiges Konto-Token). Schritt 2
(Freigabe des Standort-Entschluesselungsschluessels ueber eine zweite,
Google-eigene Seite) folgt in einer spaeteren Version.
