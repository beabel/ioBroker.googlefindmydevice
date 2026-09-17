'use strict';

// Standalone, local-only login helper for ioBroker.googlefindmydevice.
//
// Designed to also run as a double-clickable executable (built with
// @yao-pkg/pkg - see package.json's "build" script) so a typical ioBroker
// user never has to install Node.js or type a command. On first run it
// downloads its own copy of Chrome next to itself (one-time, needs
// internet access) and keeps reusing it afterwards.
//
// This tool never sees your Google password - it only reads a short-lived
// cookie after you've finished logging in yourself in a real, visible
// Chrome window, then exchanges it (locally, directly against Google's
// servers) for a long-lived token. Nothing is uploaded anywhere.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const puppeteer = require('puppeteer-core');
const { install, detectBrowserPlatform, resolveBuildId, computeExecutablePath, Browser, BrowserTag } = require('@puppeteer/browsers');

const { gcmCheckin } = require('iobroker.googlefindmydevice/lib/google-checkin');
const { exchangeToken } = require('iobroker.googlefindmydevice/lib/google-auth');

const isPkg = typeof process.pkg !== 'undefined';
const baseDir = isPkg ? path.dirname(process.execPath) : __dirname;
const CHROME_CACHE_DIR = path.join(baseDir, 'browser-cache');

async function ask(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function ensureChrome() {
  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error('Betriebssystem/Architektur konnte nicht erkannt werden.');
  }

  const buildId = await resolveBuildId(Browser.CHROME, platform, BrowserTag.STABLE);
  const executablePath = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir: CHROME_CACHE_DIR, platform });

  if (fs.existsSync(executablePath)) {
    return executablePath;
  }

  console.log('Lade Chrome herunter (nur beim allerersten Start noetig, ca. 200 MB)...');
  let lastPercent = -1;
  await install({
    browser: Browser.CHROME,
    buildId,
    cacheDir: CHROME_CACHE_DIR,
    platform,
    downloadProgressCallback: (downloadedBytes, totalBytes) => {
      const percent = Math.floor((downloadedBytes / totalBytes) * 100);
      if (percent !== lastPercent && percent % 10 === 0) {
        lastPercent = percent;
        console.log(`  ${percent}%`);
      }
    },
  });
  console.log('Download abgeschlossen.\n');

  return executablePath;
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
Dieses Programm holt sich einmalig ein langlebiges Google-Token, damit der
ioBroker-Adapter spaeter selbststaendig deine Tracker-Standorte abrufen
kann. Dein Google-Passwort wird NUR in dem gleich erscheinenden, echten
Chrome-Fenster eingegeben - dieses Programm sieht oder speichert es nicht.

Alles, was hier ausgegeben wird, bleibt auf diesem Rechner. Nichts wird an
mich, Anthropic oder sonst jemanden gesendet.
`);

  const email = await ask('Google-Kontoadresse (die, mit der die Tracker eingerichtet sind): ');
  if (!email.includes('@')) {
    throw new Error('Das sieht nicht nach einer E-Mail-Adresse aus. Abgebrochen.');
  }

  const executablePath = await ensureChrome();

  console.log('\nEs oeffnet sich jetzt ein Chrome-Fenster. Bitte melde dich dort ganz normal');
  console.log('mit deinem Google-Konto an (inkl. 2FA falls aktiv). Das Fenster schliesst');
  console.log('sich danach automatisch.\n');

  const browser = await puppeteer.launch({ executablePath, headless: false });
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
  console.log('\nDruecke Enter zum Beenden...');
  await ask('');
}

main().catch(async (err) => {
  console.error('\nFehler:', err.message);
  console.log('\nDruecke Enter zum Beenden...');
  await ask('').catch(() => {});
  process.exitCode = 1;
});
