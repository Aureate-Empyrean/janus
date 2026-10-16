# Janus security design — draft

**Status: Proposed — not reviewed.** This is a starting proposal for the review required by
`architecture/modules/janus-security-design.md`. Nothing here is a decision, and the
current implementation must not be used for real secrets. Who reviews Janus, and what
gates production use, is still Open and is the owner's decision.

## Threat model (initial)

In scope:

- **Stolen or copied vault file** (lost laptop, backup leak, synced folder): contents and
  item metadata must stay confidential; brute force must be expensive.
- **Modified vault file**: tampering must be detected, not silently accepted; weakened
  key-derivation parameters must not be accepted.
- **Compromised Nexus**: cannot read vault contents and cannot deliver Janus code
  (ADR 0009: Janus is released independently and never served by Nexus).
- **Casual exposure**: secrets hidden on overview screens, revealed only on request,
  clipboard cleared after use, vault locked after inactivity.

Out of scope for now (needs explicit treatment later): malware running as the user while
the vault is unlocked, a compromised OS or WebView, physical memory attacks, malicious
updates (until release signing exists), multi-device sync.

## Proposed construction (implemented in `crates/janus-core/src/crypto.rs`)

- **Key derivation**: Argon2id (RustCrypto `argon2` 0.6, version 0x13), 16-byte random
  salt, default 64 MiB memory, 3 passes, 1 lane. Parameters are stored in the file.
  Downgrading an existing vault by editing them fails, because the header is
  authenticated (below). Read-time bounds only reject absurd values: the accepted minimum
  (64 KiB, 1 pass) equals the test parameters and is not a security floor. A real minimum
  for production vaults is part of the review; the upper bound prevents a file from
  requesting denial-of-service work.
- **Key hierarchy**: the derived key-encryption key (KEK) wraps a random 256-bit vault key.
  Changing the master password re-wraps the vault key; contents are not re-encrypted.
- **Encryption**: XChaCha20-Poly1305 (RustCrypto `chacha20poly1305` 0.11) with random
  192-bit nonces for both the wrapped key and the contents; a fresh nonce on every save.
- **Header binding**: format, version, KDF identifier, parameters and salt are the
  associated data of both encryptions, so any header change fails authentication.
- **Randomness**: operating-system CSPRNG via `getrandom`. No custom generators.
- **Memory**: keys and decrypted items are zeroized on drop (`zeroize`); locking drops them.
  Copies inside the WebView, serde buffers and the OS are not controlled — a known limit.
- **Storage**: one JSON envelope file, written to a temporary file, flushed and renamed.
- **One-time codes**: TOTP keys are vault contents like passwords; codes are computed
  in the core (RustCrypto `hmac`/`sha1`/`sha2`) and the key is zeroized after use.
- **Export**: same construction with a fresh key under a separate export password and
  fresh salt; the header's exact bytes are the associated data ([EXPORT_FORMAT.md](EXPORT_FORMAT.md)).
  Exporting requires the master password again.
- **Password generator**: unbiased rejection sampling from the CSPRNG, look-alike
  characters removed; entropy is reported from the generation process.

Whole-vault encryption means item titles and usernames are protected at rest too.

## Known gaps before review

- No recovery key; forgetting the master password loses the vault (by design for now).
- No secure deletion guarantee on SSDs or copy-on-write filesystems.
- Clipboard clearing is best effort and depends on the platform.
- The vault format is a development format (`janus-vault-dev`); a reviewed design may
  replace it, with a migration.
- No release signing, so installers cannot yet be verified by users.
- Imports read plaintext exports of other password managers. Janus keeps their contents
  only in memory, but cannot protect or erase the source file or copies the WebView makes
  while reading it (architecture: handling of plaintext source exports is Open).
