# ioBroker.googlefindmydevice

ioBroker adapter to read tracker locations (e.g. Bluetooth item trackers) from
[Google Find Hub / Find My Device](https://www.google.com/android/find), Google's
device- and item-tracking service, and expose them as ioBroker states.

## Status: early proof of concept

Google does not offer an official API for Find Hub. This adapter is being built
on top of a reverse-engineered understanding of the protocol, cross-referenced
against [leonboe1/GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools)
(GPL-3.0). Because Find Hub tracker locations are end-to-end encrypted by
design, this is inherently more involved than a typical REST-API adapter and
may break if Google changes its internal protocol.

Currently implemented:

- [`lib/fmdn-crypto.js`](lib/fmdn-crypto.js) — the FMDN (Find My Device Network)
  end-to-end-encryption primitives (EID generation, ECIES-style location
  decryption, owner-key derivation), ported to Node.js using only the
  built-in `crypto` module. Verified byte-for-byte against an independent
  Python re-implementation of the same algorithm (see `test/`).

- [`lib/google-checkin.js`](lib/google-checkin.js) — anonymous GCM checkin
  (obtains an `androidId`/`securityToken`), verified live against Google.
- [`lib/google-auth.js`](lib/google-auth.js) — a from-scratch re-implementation
  of the relevant parts of the established
  [gpsoauth](https://github.com/simon-weber/gpsoauth) Python library
  (exchanging a browser login token for a long-lived account token, and that
  token for a service-scoped bearer token), request format verified live.
- [`tools/login-helper/`](tools/login-helper/) — a standalone, **local-only**
  companion tool (not part of the adapter's own runtime dependencies) that
  walks you through the one-time interactive Google login needed to obtain
  those tokens. Because most ioBroker installs are headless (Raspberry Pi,
  NAS, Docker), this runs on any separate PC/Mac with a real browser, and its
  output is pasted into the adapter's configuration once. See its own
  [README](tools/login-helper/README.md).

Not yet implemented: the second login-helper step (obtaining the
end-to-end-encryption "owner key" via Google's own encryption-unlock page),
the Nova/Spot API client for actually listing devices and locations, protobuf
decoding of device-update responses, and the actual ioBroker adapter scaffold
(`io-package.json`, states, admin UI).

## Attribution & License

The end-to-end-encryption routines in this adapter are a Node.js port of the
algorithm implemented in
[leonboe1/GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools),
an independently reverse-engineered client for Google's Find Hub / Find My
Device protocol, licensed GPL-3.0 by Leon Böttger. Because this adapter is a
derivative of that work, it is also licensed under the **GNU General Public
License v3.0** — see [LICENSE](LICENSE).

Copyright (c) 2026 Maik Ries <iobroker@ne-xt.de>

## Disclaimer

This project is not affiliated with, endorsed by, or supported by Google.
"Find Hub" and "Find My Device" are trademarks of Google LLC. Use at your own
risk; Google's internal APIs are undocumented and may change without notice.
