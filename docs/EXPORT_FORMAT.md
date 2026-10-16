# Janus export format (`janus-export`, version 1)

**Status: development format, part of the unreviewed security design draft.** It is
documented so that an export can be decrypted without Janus. `tools/decrypt_export.py` is
an independent reference implementation and CI decrypts a fresh export with it.

An export is UTF-8 JSON:

```json
{
  "header": "<Base64 of the header bytes>",
  "wrapped_key": { "nonce": "<Base64, 24 bytes>", "ciphertext": "<Base64>" },
  "payload":     { "nonce": "<Base64, 24 bytes>", "ciphertext": "<Base64>" }
}
```

The decoded header is JSON:

```json
{
  "format": "janus-export",
  "version": 1,
  "kdf": "argon2id-v19",
  "params": { "memory_kib": 65536, "iterations": 3, "parallelism": 1 },
  "salt": "<Base64, 16 bytes>",
  "exported_at": "<RFC 3339 UTC>"
}
```

Decryption:

1. Base64-decode `header`. Keep these exact bytes `H`; they are the associated data of both
   encryptions, so any change to the header makes decryption fail.
2. `KEK = Argon2id(password as UTF-8, salt, memory_kib, iterations, parallelism, 32 bytes, version 0x13)`.
3. `K = XChaCha20-Poly1305-decrypt(key = KEK, nonce = wrapped_key.nonce, aad = H, wrapped_key.ciphertext)`; 32 bytes.
4. `contents = XChaCha20-Poly1305-decrypt(key = K, nonce = payload.nonce, aad = H, payload.ciphertext)`.

`contents` is JSON `{"items": [...]}`. Each item has `id` (UUID), `created_at`,
`updated_at`, `folder`, `tags`, `favorite`, `history` (replaced secrets: `field`, `value`,
`replaced_at`), `type` (`login`, `secure_note`, `payment_card`, `identity`, `wifi`,
`api_secret`) and the fields of that type (see `crates/janus-core/src/item.rs`).

The export password is chosen at export time and is independent of the master password.
Janus never writes a plaintext export.
