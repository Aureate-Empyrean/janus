# Janus implementation checkpoint

Canonical source: `../architecture` (modules/janus.md, janus-security-design.md,
ADR 0004, ADR 0008, ADR 0009).

## First vertical slice — 2026-10-16

Scope: development-only standalone vault on Windows. Not production-safe.

- [x] `janus-core`: create, unlock, lock, change master password; Login and Secure Note
      items with UUIDs; encrypted single-file store behind a `VaultStore` trait (storage
      technology is Open); password generator.
- [x] Proposed cryptographic construction documented in `SECURITY_DESIGN_DRAFT.md`.
- [x] Tauri 2 desktop client with the shared tokens, teal accent, bundled Roboto,
      persistent development warning, auto-lock after 5 minutes, clipboard clearing.
- [x] CI: Linux fmt/clippy/tests, interface check under the real CSP, Windows tests,
      clippy and unsigned NSIS/MSI installers as artifacts.
- [x] First launch on Windows (owner, 2026-10-16, CI build 08b1168): install through
      SmartScreen, create vault, generated login, reveal/copy, lock, wrong password, unlock,
      persistence across restart and the vault file in `%APPDATA%` all worked.
- [ ] Security review of the draft design (reviewer and process are the owner's decision).
- [ ] Release signing (Authenticode / release key) and a published release.

## Item types — 2026-10-16

- [x] Payment Card, Identity document (passport, national ID, driving licence, other),
      Wi-Fi and API secret items alongside Login and Secure Note. Overview subtitles never
      contain secrets (cards show only the last four digits).
- [x] Interface driven by one field schema per type; "New" from All items asks for a type.

## Next candidates (V1 per architecture)

TOTP; folders/tags/favorites; item
history; encrypted export; import from common formats. Then browser autofill.
