'use strict';

// Standalone, local-only login helper for ioBroker.googlefindmydevice.
//
// Run this on any PC/Mac/Linux machine that has a graphical browser - it
// does NOT need to be the machine running ioBroker. It opens a real,
// visible Chrome window for you to log into your Google account yourself;
// this script never sees or handles your Google password. It only reads a
// short-lived token from a cookie after you've finished logging in, then
// exchanges it (locally, directly against Google's servers) for a
// long-lived token the adapter can use.
//
// Nothing produced here is uploaded anywhere. Treat the printed output like
// a password: it grants read access to your Find Hub tracker locations.

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const puppeteer = require('puppeteer');

const { gcmCheckin } = require('../../lib/google-checkin');
const { exchangeToken } = require('../../lib/google-auth');

async function ask(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function waitForOauthTokenCookie(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cookies = await page.cookies('https://accounts.google.com');
    const cookie = cookies.find((c) => c.name === 'oauth_token');
    if (cookie) return cookie.value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Timeout: Es wurde innerhalb der Wartezeit kein Google-Login abgeschlossen.');
}

async function main() {
  console.log('='.repeat(70));
  console.log('ioBroker.googlefindmydevice - Login-Hilfsskript (Schritt 1/2)');
  console.log('='.repeat(70));
  console.log(`
Dieses Skript holt sich einmalig ein langlebiges Google-Token, damit der
ioBroker-Adapter spaeter selbststaendig deine Tracker-Standorte abrufen
kann. Dein Google-Passwort wird NUR in dem gleich erscheinenden, echten
Chrome-Fenster eingegeben - dieses Skript sieht oder speichert es nicht.

Alles, was hier ausgegeben wird, bleibt auf diesem Rechner. Nichts wird an
mich, Anthropic oder sonst jemanden gesendet.
`);

  const email = await ask('Google-Kontoadresse (die, mit der die Tracker eingerichtet sind): ');
  if (!email.includes('@')) {
    throw new Error('Das sieht nicht nach einer E-Mail-Adresse aus. Abgebrochen.');
  }

  console.log('\nEs oeffnet sich jetzt ein Chrome-Fenster. Bitte melde dich dort ganz normal');
  console.log('mit deinem Google-Konto an (inkl. 2FA falls aktiv). Das Fenster schliesst');
  console.log('sich danach automatisch.\n');

  const browser = await puppeteer.launch({ headless: false });
  let oauthToken;
  try {
    const page = await browser.newPage();
    await page.goto('https://accounts.google.com/EmbeddedSetup', { waitUntil: 'domcontentloaded' });
    oauthToken = await waitForOauthTokenCookie(page, 5 * 60 * 1000);
    console.log('Login erkannt.');
  } finally {
    await browser.close();
  }

  console.log('\nHole Geraete-Identitaet (anonymer GCM-Checkin)...');
  const { androidId, securityToken } = await gcmCheckin();

  console.log('Tausche Login-Token gegen langlebiges Konto-Token...');
  const exchangeResult = await exchangeToken(email, oauthToken, androidId);
  const aasToken = exchangeResult.Token;

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
}

main().catch((err) => {
  console.error('\nFehler:', err.message);
  process.exitCode = 1;
});
