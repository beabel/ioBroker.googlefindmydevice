'use strict';

// Standalone, local-only login helper for ioBroker.googlefindmydevice.
//
// Designed to also run as a double-clickable executable (built with
// @yao-pkg/pkg - see package.json's "build" script) so a typical ioBroker
// user never has to install Node.js or type a command.
//
// This tool never sees your Google password - it only reads a short-lived
// cookie after you've finished logging in yourself in a real, visible
// Chrome window, then exchanges it (locally, directly against Google's
// servers) for a long-lived token. Everything happens on this machine.

const fs = require('node:fs');
const os = require('node:os');
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

// Google's sign-in page rejects generic "Chrome for Testing" builds (the
// kind Puppeteer downloads by default) with "This browser or app may not
// be secure". A real, everyday Google Chrome installation is not affected,
// so we prefer that if one is present and only fall back to downloading a
// throwaway copy if it isn't.
function findSystemChrome() {
  const candidates = [];
  const platform = os.platform();

  if (platform === 'win32') {
    const programFiles = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean);
    for (const base of programFiles) {
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push(path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/snap/bin/chromium');
  }

  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function ensureChrome() {
  const systemChrome = findSystemChrome();
  if (systemChrome) {
    console.log(`Verwende dein installiertes Chrome: ${systemChrome}`);
    return systemChrome;
  }

  console.log('Kein installiertes Google Chrome gefunden.');
  console.log('Hinweis: Google blockiert Anmeldungen in generischen Testversionen von Chrome');
  console.log('gelegentlich mit der Meldung "Dieser Browser oder App ist unsicher". Falls das');
  console.log('gleich passiert, installiere bitte das normale Google Chrome und starte dieses');
  console.log('Programm erneut - es wird dann automatisch bevorzugt verwendet.\n');

  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error('Betriebssystem/Architektur konnte nicht erkannt werden.');
  }

  const buildId = await resolveBuildId(Browser.CHROME, platform, BrowserTag.STABLE);
  const executablePath = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir: CHROME_CACHE_DIR, platform });

  if (fs.existsSync(executablePath)) {
    return executablePath;
  }

  console.log('Lade eine eigene Chrome-Kopie herunter (nur beim allerersten Start noetig, ca. 200 MB)...');
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
Es laeuft alles lokal auf diesem Rechner ab.
`);

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
  // Google derives the account from the token itself, so no email needs to
  // be entered by hand - it comes back in the exchange response.
  const exchangeResult = await exchangeToken('', oauthToken, androidId);
  const aasToken = exchangeResult.Token;
  const email = exchangeResult.Email;

  if (!email) {
    throw new Error('Google hat keine Kontoadresse zurueckgegeben. Bitte erneut versuchen.');
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
