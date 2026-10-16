#!/usr/bin/env python3
"""Reference decryptor for Janus exports (janus-export v1), independent of Janus code.

Usage: decrypt_export.py <file> <export password>  — prints the decrypted JSON to stdout.
Requires: pip install argon2-cffi pynacl
"""

import base64
import json
import sys

from argon2.low_level import Type, hash_secret_raw
from nacl.bindings import crypto_aead_xchacha20poly1305_ietf_decrypt


def decrypt(data: bytes, password: str) -> dict:
    file = json.loads(data)
    header_bytes = base64.b64decode(file["header"])  # exact bytes: also the associated data
    header = json.loads(header_bytes)
    if header["format"] != "janus-export" or header["version"] != 1 or header["kdf"] != "argon2id-v19":
        raise ValueError("not a janus-export v1 file")
    params = header["params"]
    kek = hash_secret_raw(
        password.encode(),
        base64.b64decode(header["salt"]),
        time_cost=params["iterations"],
        memory_cost=params["memory_kib"],
        parallelism=params["parallelism"],
        hash_len=32,
        type=Type.ID,
        version=19,
    )

    def open_sealed(key: bytes, sealed: dict) -> bytes:
        return crypto_aead_xchacha20poly1305_ietf_decrypt(
            base64.b64decode(sealed["ciphertext"]), header_bytes, base64.b64decode(sealed["nonce"]), key
        )

    key = open_sealed(kek, file["wrapped_key"])
    return json.loads(open_sealed(key, file["payload"]))


if __name__ == "__main__":
    with open(sys.argv[1], "rb") as f:
        print(json.dumps(decrypt(f.read(), sys.argv[2]), indent=2))
