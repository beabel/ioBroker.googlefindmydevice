# Older changelog entries

Nothing has moved here yet - see the "Changelog" section in
[README.md](README.md) for the current history. Once that section
grows too long, older entries will be moved into this file.
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

Older entries, once this section grows too long, will move to
