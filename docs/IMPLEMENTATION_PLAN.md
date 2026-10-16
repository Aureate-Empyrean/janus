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
- [ ] First launch on Windows: so far the interface is checked only against a mocked core
      and the installers only built in CI (IPC, WebView2 CSP and clipboard not yet exercised).
- [ ] Security review of the draft design (reviewer and process are the owner's decision).
- [ ] Release signing (Authenticode / release key) and a published release.

## Next candidates (V1 per architecture)

Payment Card, Identity, Wi-Fi and API secret items; TOTP; folders/tags/favorites; item
history; encrypted export; import from common formats. Then browser autofill.
