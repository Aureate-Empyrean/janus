//! Vault envelope (proposed format, not reviewed; see docs/SECURITY_DESIGN_DRAFT.md).
//!
//! master password --Argon2id(salt, params)--> KEK
//! KEK --XChaCha20-Poly1305(nonce_k, aad=header)--> wrapped random 256-bit vault key
//! vault key --XChaCha20-Poly1305(nonce_p, aad=header)--> serialized contents
//!
//! The header (format, version, KDF parameters, salt) is bound as associated data, so a
//! modified parameter or salt makes unwrapping fail instead of silently weakening the vault.

use crate::{Error, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const FORMAT: &str = "janus-vault-dev";
const VERSION: u32 = 1;
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;
pub(crate) const SALT_LEN: usize = 16;

/// Argon2id cost parameters.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl Default for KdfParams {
    /// Proposed default: 64 MiB, 3 passes, 1 lane (above the OWASP minimum; pending review).
    fn default() -> Self {
        Self {
            memory_kib: 64 * 1024,
            iterations: 3,
            parallelism: 1,
        }
    }
}

impl KdfParams {
    /// Cheap parameters for tests only.
    pub fn insecure_for_tests() -> Self {
        Self {
            memory_kib: 64,
            iterations: 1,
            parallelism: 1,
        }
    }

    // Refuse files that claim trivially weak parameters (tests use the weakest allowed values).
    pub(crate) fn validate(&self) -> Result<()> {
        if self.memory_kib < 64 || self.iterations < 1 || !(1..=16).contains(&self.parallelism) {
            return Err(Error::Format(
                "unsupported key derivation parameters".into(),
            ));
        }
        if self.memory_kib > 4 * 1024 * 1024 || self.iterations > 64 {
            return Err(Error::Format(
                "key derivation parameters are unreasonably large".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub(crate) struct VaultKey([u8; KEY_LEN]);

impl VaultKey {
    pub(crate) fn generate() -> Result<Self> {
        let mut key = [0u8; KEY_LEN];
        random(&mut key)?;
        Ok(Self(key))
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        &self.0
    }

    pub(crate) fn from_slice(raw: &[u8]) -> Result<Self> {
        Ok(Self(raw.try_into().map_err(|_| Error::Unlock)?))
    }

    fn cipher(&self) -> Result<XChaCha20Poly1305> {
        XChaCha20Poly1305::new_from_slice(&self.0).map_err(|_| Error::Crypto)
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Header {
    format: String,
    version: u32,
    kdf: String,
    params: KdfParams,
    salt: String,
}

impl Header {
    fn aad(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(self).map_err(|_| Error::Crypto)
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Sealed {
    nonce: String,
    ciphertext: String,
}

/// The complete on-disk vault: header, wrapped key and encrypted contents.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Envelope {
    header: Header,
    wrapped_key: Sealed,
    payload: Option<Sealed>,
}

impl Envelope {
    pub(crate) fn wrap(key: &VaultKey, password: &str, params: KdfParams) -> Result<Self> {
        params.validate()?;
        let mut salt = [0u8; SALT_LEN];
        random(&mut salt)?;
        let header = Header {
            format: FORMAT.into(),
            version: VERSION,
            kdf: "argon2id-v19".into(),
            params,
            salt: B64.encode(salt),
        };
        let kek = derive(password, &salt, params)?;
        let wrapped_key = seal(&kek, &key.0, &header.aad()?)?;
        Ok(Self {
            header,
            wrapped_key,
            payload: None,
        })
    }

    pub(crate) fn parse(bytes: &[u8]) -> Result<Self> {
        let envelope: Self =
            serde_json::from_slice(bytes).map_err(|e| Error::Format(e.to_string()))?;
        let h = &envelope.header;
        if h.format != FORMAT || h.version != VERSION || h.kdf != "argon2id-v19" {
            return Err(Error::Format(format!("{} v{}", h.format, h.version)));
        }
        h.params.validate()?;
        Ok(envelope)
    }

    pub(crate) fn unwrap_key(&self, password: &str) -> Result<VaultKey> {
        let salt = decode(&self.header.salt)?;
        if salt.len() != SALT_LEN {
            return Err(Error::Format("salt".into()));
        }
        let kek = derive(password, &salt, self.header.params)?;
        let raw = Zeroizing::new(open(&kek, &self.wrapped_key, &self.header.aad()?)?);
        let bytes: [u8; KEY_LEN] = raw.as_slice().try_into().map_err(|_| Error::Unlock)?;
        Ok(VaultKey(bytes))
    }

    pub(crate) fn seal_payload(&mut self, key: &VaultKey, plaintext: &[u8]) -> Result<()> {
        self.payload = Some(seal(key, plaintext, &self.header.aad()?)?);
        Ok(())
    }

    pub(crate) fn open_payload(&self, key: &VaultKey) -> Result<Vec<u8>> {
        let payload = self
            .payload
            .as_ref()
            .ok_or(Error::Format("missing contents".into()))?;
        open(key, payload, &self.header.aad()?)
    }

    pub(crate) fn to_bytes(&self) -> Result<Vec<u8>> {
        serde_json::to_vec_pretty(self).map_err(|_| Error::Crypto)
    }
}

pub(crate) fn derive(password: &str, salt: &[u8], params: KdfParams) -> Result<VaultKey> {
    let params = Params::new(
        params.memory_kib,
        params.iterations,
        params.parallelism,
        Some(KEY_LEN),
    )
    .map_err(|_| Error::Format("key derivation parameters".into()))?;
    let mut out = [0u8; KEY_LEN];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|_| Error::Crypto)?;
    let key = VaultKey(out);
    out.zeroize();
    Ok(key)
}

pub(crate) fn seal(key: &VaultKey, plaintext: &[u8], aad: &[u8]) -> Result<Sealed> {
    // Random 192-bit nonces: collision risk is negligible for a vault's write volume.
    let mut nonce = [0u8; NONCE_LEN];
    random(&mut nonce)?;
    let ciphertext = key
        .cipher()?
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| Error::Crypto)?;
    Ok(Sealed {
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
    })
}

pub(crate) fn open(key: &VaultKey, sealed: &Sealed, aad: &[u8]) -> Result<Vec<u8>> {
    let nonce: [u8; NONCE_LEN] = decode(&sealed.nonce)?
        .as_slice()
        .try_into()
        .map_err(|_| Error::Format("nonce".into()))?;
    let ciphertext = decode(&sealed.ciphertext)?;
    key.cipher()?
        .decrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &ciphertext,
                aad,
            },
        )
        .map_err(|_| Error::Unlock)
}

fn decode(value: &str) -> Result<Vec<u8>> {
    B64.decode(value)
        .map_err(|_| Error::Format("encoding".into()))
}

pub(crate) fn random(buf: &mut [u8]) -> Result<()> {
    getrandom::fill(buf).map_err(|_| Error::Crypto)
}
