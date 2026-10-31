# Older changelog entries

See the "Changelog" section in [README.md](README.md) for the current
history. Entries move here once that section grows too long.

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
