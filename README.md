# ioBroker.googlefindmydevice

ioBroker adapter to read tracker locations (e.g. Bluetooth item trackers) from
[Google Find Hub / Find My Device](https://www.google.com/android/find), Google's
device- and item-tracking service, and expose them as ioBroker states.

## Status: early development

Google does not offer an official API for Find Hub. This adapter is being built
on top of a reverse-engineered understanding of the protocol, cross-referenced
against [leonboe1/GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools)
(GPL-3.0). Because Find Hub tracker locations are end-to-end encrypted by
design, this is inherently more involved than a typical REST-API adapter and
may break if Google changes its internal protocol.

Currently implemented and confirmed working against real Google accounts:

- Reading a Google account's Find Hub device list (names) and keeping it
  updated on a poll interval.
- All setup happens inside the adapter's own configuration page in ioBroker
  Admin - see **Setup** below. No separate program or browser automation is
  needed or used.

Not yet implemented: decrypting the actual location reports (needs the
end-to-end-encryption "owner key", obtained via a second Google login step -
see [`lib/fmdn-crypto.js`](lib/fmdn-crypto.js) for the already-working
decryption primitives once that key is available), and the corresponding
latitude/longitude/last-seen states per tracker.

## Setup

The adapter needs a one-time login to your Google account. No password is
ever entered into the adapter - only a short-lived token you copy out of
your own browser, exactly like you'd copy an API key from some other web
dashboard:

1. Open `https://accounts.google.com/EmbeddedSetup` in your own browser and
   log in with the Google account your trackers are linked to (including
   two-factor confirmation if enabled). The page may look empty afterwards -
   that's normal, it isn't meant for humans.
2. Open your browser's developer tools (`F12`) → "Application" tab →
   "Cookies" → `https://accounts.google.com`.
3. Find the row named `oauth_token` and copy its full value.
4. Paste it into the adapter instance's configuration page (in ioBroker
   Admin) and save.

The adapter exchanges that value for a long-lived token on its own, clears
the pasted value from its configuration, and restarts. From then on it
refreshes what it needs by itself - you only repeat this if Google
invalidates the session at some point down the line.

**Why not automate this login?** An earlier version of this project tried
driving a real browser (Puppeteer) through the login. Google reliably
detects that and blocks it with "this browser or app may not be secure" -
confirmed by testing. The reliable fix for that is dedicated bot-detection-
evasion tooling, which this project deliberately does not use. Logging in
yourself, in your own normal browser, sidesteps the problem entirely since
there is nothing to detect.

## Attribution & License

The end-to-end-encryption routines in this adapter are a Node.js port of the
algorithm implemented in
[leonboe1/GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools),
an independently reverse-engineered client for Google's Find Hub / Find My
Device protocol, licensed GPL-3.0 by Leon Böttger. The GCM-checkin and
account-login exchange re-implement the relevant parts of the established
[gpsoauth](https://github.com/simon-weber/gpsoauth) Python library (MIT,
Simon Weber). Because this adapter is a derivative of that GPL-3.0 work, it
is also licensed under the **GNU General Public License v3.0** — see
[LICENSE](LICENSE).

Copyright (c) 2026 Maik Ries <iobroker@ne-xt.de>

## Disclaimer

This project is not affiliated with, endorsed by, or supported by Google.
"Find Hub" and "Find My Device" are trademarks of Google LLC. Use at your own
risk; Google's internal APIs are undocumented and may change without notice.
