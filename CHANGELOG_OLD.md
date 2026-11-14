# Older changelog entries

See the "Changelog" section in [README.md](README.md) for the current
history. Entries move here once that section grows too long.

## 0.1.4 (2026-10-31)

* (beabel) **NEW**: optional BLE identifier (EID) states for trackers (off by default, switch on per tracker in the device table).
* (beabel) **FIXED**: push messages are now read correctly even if Google adds extra parameters to the encryption headers; if a push message still cannot be decrypted, the debug log says why (sizes and parameter names only).
* (beabel) **ENHANCED**: the debug log shows the structure of the identifier block of every device (field numbers and sizes only, never names or ids) to help support devices such as headphones.

## 0.1.3 (2026-10-31)

* (beabel) **ENHANCED**: the debug log now lists every device that is left out because Google gives it no tracker
  identifier (manufacturer, model and type, never its name), and the README explains which devices appear.
* (beabel) **ENHANCED**: the README says explicitly that saving after "Connect" restarts the instance before Part 2.
* (beabel) **TESTING**: updated `@iobroker/testing` to 6.3.1.

## 0.1.2 (2026-10-03)

* (beabel) **ENHANCED**: admin translations moved to the short i18n format (`admin/i18n/<lang>.json`); updated
  `@iobroker/testing` to 6.3.0.
* (beabel) **ENHANCED**: the Google account's email address is no longer written to the log.

## 0.1.1 (2026-10-03)

* (beabel) **FIXED**: the configuration page now tells you to start the instance first. Its buttons (Connect, Verify and
  unlock, ...) only work while the instance is running, and a new instance starts disabled, so the **Connect** button
  looked broken. The README says the same.

## 0.1.0 (2026-10-03)

* (beabel) **ENHANCED**: the setup shows only what is still needed. The steps work through buttons (**Connect**,
  **Verify and unlock**) whose result appears in the page at once, so Part 1 and its token field disappear as soon
  as the account is connected and a wrong or expired value is reported immediately instead of only in the log.
  **Connect a different account** starts over. The instructions are split into Part 1 (connect the account) and
  Part 2 (unlock the locations), each with five numbered steps, and the token and console-result fields no longer
  trigger the browser's password suggestions (they are still stored encrypted).
* (beabel) **NEW**: Part 2 of the setup (unlocking locations) is done from the configuration page: a button opens Google's unlock page,
  another shows the console script with a copy button, and the screenshots of both parts are shown in the page.
  The log still carries the same instructions.
* (beabel) **ENHANCED**: BREAKING - every tracker is now a `device` object directly below the instance
  (`googlefindmydevice.0.<id>.*`) instead of a channel in a `devices` folder
  (`googlefindmydevice.0.devices.<id>.*`). The old tree is removed automatically on the first start; update
  scripts and visualizations that use the old state IDs.
* (beabel) **ENHANCED**: more specific state roles (`info.name`, `info.model`, `value.gps.accuracy`).
* (beabel) **ENHANCED**: objects are written once per run and states only when their value changes.
* (beabel) **FIXED**: no new timers are started while the adapter is shutting down.
* (beabel) **FIXED**: two error messages that reached the log in German are now English.
* (beabel) **FIXED**: new instances start disabled.
* (beabel) **ENHANCED**: README restructured (Installation, Configuration, Usage, Support); admin translations
  moved to `admin/i18n/<lang>/translations.json`.
* (beabel) **TESTING**: unit tests for location decryption (own and relayed reports, wrong key, tampering),
  configuration repair, interval limits, object definitions and the MCS client; linting fails on any warning.

## 0.0.7 (2026-09-18)

* (beabel) **ENHANCED**: replaced the `any`-casts introduced for the `@tsconfig/node22` migration with specific
  types and filled in missing JSDoc descriptions.
* (beabel) **CI/CD**: added `@alcalzone/release-script` (release-time tool only, not part of the published package).

## 0.0.6 (2026-09-18)

* (beabel) **FIXED**: the 0.0.5 fixes only applied to newly discovered devices, because existing objects were
  never updated. Object definitions are now merged in with `extendObject`, so existing installs pick up changes.
* (beabel) **FIXED**: findings of the ioBroker repository checker: `node:`-prefixed built-in imports, adapter
  timers instead of raw `setInterval`/`setTimeout` in `lib/mcs-client.js`, stale `news` entries for versions that
  were never published, `tsconfig.json` extends `@tsconfig/node22`, `json.schemas` in `.vscode/settings.json`,
  `CHANGELOG_OLD.md`, Dependabot auto-merge workflow.

## 0.0.5 (2026-09-18)

* (beabel) **FIXED**: findings of the object structure check: added the missing parent object of the per-device
  channels, replaced the invalid `weblink` role of the Google Maps link by `text.url`, and expanded all object
  names to the 11 recommended languages.

## 0.0.4 (2026-09-18)

* (beabel) **CI/CD**: verified the automated release pipeline (git tag, GitHub Actions, npm trusted publishing,
  GitHub release) end to end; invited `bluefox` as npm maintainer.

## 0.0.3 (2026-09-18)

* (beabel) **FIXED**: the repair of corrupted configuration values now checks the actual values on every start
  instead of relying on a one-time flag in the instance config.

## 0.0.2 (2026-09-18)

* (beabel) Fix a config-corruption bug introduced by the `protectedNative`/
  `encryptedNative` schema fix below: this adapter used to save the login
  token, security token, shared key and owner key with a plain
  `extendForeignObjectAsync()` call, which never encrypted them - but
  js-controller now (correctly) tries to decrypt every field in
  `encryptedNative` on every startup, turning those still-plain values into
  garbage. Saving now goes through `updateConfig()` instead, which encrypts
  them properly, and existing instances self-repair once on their next
  startup (their already-garbled values get decrypted a second time, which
  restores the original since the legacy XOR cipher is its own inverse).
  If you were affected, you'll see a "Repairing configuration values..."
  log line once, followed by one extra automatic restart - no action
  needed.

## 0.0.1 (2026-09-18)

* (beabel) Initial development version - Bluetooth tracker names/metadata,
  location decryption, and active per-device location requests.
