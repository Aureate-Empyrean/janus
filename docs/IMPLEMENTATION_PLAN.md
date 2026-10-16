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

## One-time codes (TOTP) — 2026-10-16

- [x] Logins can hold an authenticator key (Base32 or `otpauth://totp/` link, SHA-1/256/512,
      6–8 digits, custom period). Codes are generated locally per RFC 6238 and verified
      against the RFC's test vectors. HOTP is rejected. Older vaults load unchanged.
- [x] The detail view shows the live code with seconds remaining and Copy; the key stays
      masked.

## Organization and history — 2026-10-16

- [x] Folders (one per item), tags (up to 20) and favorites, with sidebar filters and search
      over tags and folders. Metadata edits never touch secrets.
- [x] Replaced passwords, Wi-Fi keys, API secrets and card PINs are kept newest first (up to
      20) under "Previous values", masked like other secrets and never in the overview.
- [x] Saving an item and its metadata is one validated write.

## Encrypted export — 2026-10-16

- [x] Export of all items to Downloads under a separate export password, after re-entering
      the master password. No plaintext export exists.
- [x] Format `janus-export` v1 documented in `EXPORT_FORMAT.md`; CI decrypts a fresh export
      with the independent `tools/decrypt_export.py` (argon2-cffi + PyNaCl).
- [x] Import of Janus exports with a preview; identities are kept and items already present
      are left unchanged.

## Import from other password managers — 2026-10-16

- [x] Bitwarden unencrypted JSON (logins with all URLs, authenticator key and password
      history; secure notes; cards; identities mapped to documents; unknown types kept as
      secure notes) and browser password CSV (Chrome, Edge, Firefox; header-driven).
- [x] Preview first. Fields without a Janus counterpart are appended to notes and counted,
      never dropped. Encrypted Bitwarden exports are refused with instructions.
- [x] The interface warns that the source file is plaintext and asks the user to delete it.

## Field rules — 2026-10-16

- [x] One rule set in the core (`rules.rs`), used by saving, by the form (`check_item`)
      and by imports. Cards: 12–19 digits with Luhn check, MM/YY expiry, 3–4 digit security
      code, 4–12 digit PIN. Wi-Fi: SSID ≤ 32 bytes, WPA 8–63 characters or 64 hex, WEP
      5/13 characters or 10/26 hex, open means no password. Identity: real dates, expiry
      not before issue, bounded document numbers. Every text field has a length limit and
      every item needs a title.
- [x] The form limits typing (digits only, grouping, auto MM/YY) and shows the core's
      message under each field.
- [x] Imports never fail on a rule: a breaking value moves into the item's notes, with a
      warning in the preview.

## Spotlight interface — 2026-10-16

Owner asked for something more fluent and modern than sidebar + list, with a bolder Janus
look, and may adopt it for other apps if it works out (that would need an architecture ADR).

- [x] Search-first home: large search field (Ctrl+K or /), filter chips (types, favorites,
      folders), favorite tiles and recently changed items. Arrow keys select, Enter opens,
      Ctrl+Enter copies the main secret; Esc clears.
- [x] Details, editing, export/import and master password open in a sheet that slides in
      over the page; Esc closes and focus returns.
- [x] Payment cards drawn as cards (brand from the number, number masked until revealed);
      one-time codes with a countdown ring; Wi-Fi "join" QR code generated in Rust, shown
      only on request.
- [x] Type hues for recognition, layered surfaces, staggered entrances; everything still
      uses the shared tokens and honours reduced motion. Hover never moves elements.

## Next candidates (V1 per architecture)

KeePass and 1Password imports; browser autofill (early follow-up).
