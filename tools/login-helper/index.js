'use strict';

// Standalone, local-only login helper for ioBroker.googlefindmydevice.
//
// No browser automation of any kind: you log into Google yourself, in your
// own everyday browser, exactly like on any normal website. This tool only
// takes one value you copy out of your browser's developer tools afterwards
// and exchanges it (locally, directly against Google's servers) for a
// long-lived token. Your Google password never touches this tool.

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const { gcmCheckin } = require('iobroker.googlefindmydevice/lib/google-checkin');
const { exchangeToken, performOAuth, DEFAULT_CLIENT_SIG } = require('iobroker.googlefindmydevice/lib/google-auth');
const { listDevices } = require('iobroker.googlefindmydevice/lib/nova-api');

async function ask(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function printInstructions() {
  console.log('='.repeat(70));
  console.log('ioBroker.googlefindmydevice - Login-Hilfsskript (Schritt 1/2)');
  console.log('='.repeat(70));
  console.log(`
Dieses Programm holt sich einmalig ein langlebiges Google-Token, damit der
ioBroker-Adapter spaeter selbststaendig deine Tracker-Standorte abrufen
kann. Es steuert dabei KEINEN Browser fern - du meldest dich ganz normal
in deinem eigenen Browser an. Es laeuft alles lokal auf diesem Rechner ab.

So gehst du vor:

  1. Oeffne in deinem normalen Browser (Chrome, Edge, ...) diese Adresse
     in einem NEUEN Tab:

         https://accounts.google.com/EmbeddedSetup

  2. Melde dich dort ganz normal mit dem Google-Konto an, mit dem deine
     Find-Hub-Tracker verknuepft sind (inkl. Zwei-Faktor-Bestaetigung,
     falls aktiv). Die Seite sieht danach evtl. leer/leicht kaputt aus -
     das ist normal, sie ist nicht fuer Menschen gedacht.

  3. Oeffne die Entwicklertools deines Browsers, z.B. mit der Taste F12
     (Chrome/Edge). Wechsle dort zum Reiter "Anwendung" (englisch:
     "Application").

  4. Klicke dort links unter "Cookies" auf
     "https://accounts.google.com".

  5. Suche in der Tabelle rechts die Zeile mit dem Namen "oauth_token"
     und kopiere den kompletten Wert aus der Spalte "Value" (Doppelklick
     auf den Wert, dann Strg+A / Cmd+A und Strg+C / Cmd+C zum Kopieren -
     der Wert ist recht lang).

Sobald du den Wert kopiert hast, komm zurueck hierher.
`);
}

async function main() {
  printInstructions();

  const oauthToken = await ask('Kopierten "oauth_token"-Wert hier einfuegen und Enter druecken: ');
  if (!oauthToken || oauthToken.length < 20) {
    throw new Error('Das sieht nicht nach einem gueltigen oauth_token-Wert aus. Abgebrochen.');
  }

  console.log('\nHole Geraete-Identitaet (anonymer GCM-Checkin)...');
  const { androidId, securityToken } = await gcmCheckin();

  console.log('Tausche Login-Token gegen langlebiges Konto-Token...');
  // Google derives the account from the token itself, so no email needs to
  // be entered by hand - it comes back in the exchange response.
  const exchangeResult = await exchangeToken('', oauthToken, androidId);
  const aasToken = exchangeResult.Token;
  const email = exchangeResult.Email;

  if (!aasToken || !email) {
    throw new Error(
      'Google hat kein gueltiges Token zurueckgegeben. Moegliche Ursachen: der oauth_token-Wert ' +
        'ist schon abgelaufen (er gilt nur kurz - bitte Schritt 1-5 direkt vor dem Einfuegen ' +
        'wiederholen) oder wurde beim Kopieren unvollstaendig uebernommen.',
    );
  }

  console.log('Teste die Verbindung: hole deine Geraeteliste von Google...');
  try {
    const { Auth: admToken } = await performOAuth(
      email,
      aasToken,
      androidId,
      'oauth2:https://www.googleapis.com/auth/android_device_manager',
      'com.google.android.apps.adm',
      DEFAULT_CLIENT_SIG,
    );
    const devices = await listDevices(admToken);
    if (devices.length === 0) {
      console.log('Verbindung erfolgreich, aber keine Tracker in deinem Konto gefunden.');
    } else {
      console.log(`Verbindung erfolgreich! Gefundene Tracker (${devices.length}):`);
      for (const d of devices) {
        console.log(`  - ${d.name}`);
      }
    }
  } catch (err) {
    console.log(`Hinweis: Geraeteliste konnte nicht abgerufen werden (${err.message}).`);
    console.log('Die oben erzeugten Zugangsdaten sind trotzdem gueltig und gespeichert.');
  }

  console.log('\n' + '='.repeat(70));
  console.log('Schritt 1 erfolgreich. Bitte sichere diese Werte (z.B. in einem');
  console.log('Passwortmanager) - sie werden fuer Schritt 2 und fuer die spaetere');
  console.log('Adapter-Konfiguration gebraucht:');
  console.log('='.repeat(70));
  console.log(
    JSON.stringify(
      {
        email,
        androidId,
        securityToken,
        aasToken,
      },
      null,
      2,
    ),
  );
  console.log('\nSchritt 2 (Freigabe des Standort-Entschluesselungsschluessels) folgt in');
  console.log('einem separaten Lauf dieses Tools, sobald er implementiert ist.');
  console.log('\nDruecke Enter zum Beenden...');
  await ask('');
}

main().catch(async (err) => {
  console.error('\nFehler:', err.message);
  console.log('\nDruecke Enter zum Beenden...');
  await ask('').catch(() => {});
  process.exitCode = 1;
});
