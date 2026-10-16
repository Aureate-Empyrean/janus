# Janus

Local-first encrypted vault for credentials, secrets and sensitive records, part of
Aureate Empyrean. Canonical architecture: `architecture/modules/janus.md` and
[ADR 0009](https://github.com/Aureate-Empyrean/architecture/blob/main/decisions/0009-janus-client-delivery.md).
Licensed AGPL-3.0-or-later.

> **Development build. The cryptographic design has not been reviewed. Do not store
> real secrets in Janus yet.** The app shows this warning permanently until a reviewed
> design exists ([security design draft](docs/SECURITY_DESIGN_DRAFT.md)).

## What exists

- `crates/janus-core`: vault create/unlock/lock, master-password change, Login and
  Secure Note items with UUID identities, one encrypted vault file, password generator.
- `apps/desktop`: Tauri 2 desktop client. Plain HTML/CSS/JS interface using the shared
  Aureate tokens with Janus teal. Strict content security policy, no remote content, no
  shell/filesystem/HTTP/updater plugins, no automatic updates.

Janus is not served or updated by Nexus. It works with no Nexus at all; synchronization is
later work.

## Windows build

Every push builds unsigned Windows installers (NSIS `.exe` and `.msi`) on GitHub Actions:
open the latest **CI** run, then download `janus-windows-dev-<commit>` under Artifacts.
Windows SmartScreen warns because the build is not code-signed; signing is required before
any real use and is not decided yet.

The vault is stored in `%APPDATA%\org.aureate-empyrean.janus\vault.janus`.

## Development

```sh
cargo test -p janus-core              # core tests (any OS)
cargo clippy -p janus-core --all-targets -- -D warnings
cargo fmt --all --check
# Desktop app (needs the Tauri prerequisites for your OS):
cd apps/desktop && npx @tauri-apps/cli@2.12.1 dev
# Interface check with the real CSP and a mocked core (Playwright):
node apps/desktop/tests/ui_preview.cjs artifacts
```
