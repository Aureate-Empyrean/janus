//! Password-protected export (format `janus-export` v1), documented in docs/EXPORT_FORMAT.md
//! so independent tools can decrypt it. Never plaintext.
//!
//! The header is stored as Base64 of its exact bytes, and those bytes are the associated
//! data, so a reader needs no canonical JSON re-serialization.

use crate::crypto::{self, KdfParams, VaultKey};
use crate::item::Item;
use crate::{Error, Result};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

pub const EXPORT_FORMAT: &str = "janus-export";
pub const EXPORT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct ExportHeader {
    format: String,
    version: u32,
    kdf: String,
    params: KdfParams,
    salt: String,
    exported_at: String,
}

#[derive(Serialize, Deserialize)]
struct ExportFile {
    header: String,
    wrapped_key: crypto::Sealed,
    payload: crypto::Sealed,
}

#[derive(Serialize, Deserialize)]
struct ExportContents {
    items: Vec<Item>,
}

pub(crate) fn seal_export(items: &[Item], password: &str, params: KdfParams) -> Result<Vec<u8>> {
    let mut salt = [0u8; crypto::SALT_LEN];
    crypto::random(&mut salt)?;
    let exported_at = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| Error::Crypto)?;
    let header = serde_json::to_vec(&ExportHeader {
        format: EXPORT_FORMAT.into(),
        version: EXPORT_VERSION,
        kdf: "argon2id-v19".into(),
        params,
        salt: B64.encode(salt),
        exported_at,
    })
    .map_err(|_| Error::Crypto)?;
    let kek = crypto::derive(password, &salt, params)?;
    let key = VaultKey::generate()?;
    let wrapped_key = crypto::seal(&kek, key.bytes(), &header)?;
    let plaintext = Zeroizing::new(
        serde_json::to_vec(&ExportContents {
            items: items.to_vec(),
        })
        .map_err(|_| Error::Crypto)?,
    );
    let payload = crypto::seal(&key, &plaintext, &header)?;
    serde_json::to_vec_pretty(&ExportFile {
        header: B64.encode(&header),
        wrapped_key,
        payload,
    })
    .map_err(|_| Error::Crypto)
}

pub(crate) fn open_export(bytes: &[u8], password: &str) -> Result<Vec<Item>> {
    let file: ExportFile = serde_json::from_slice(bytes)
        .map_err(|_| Error::Invalid("This is not a Janus export file".into()))?;
    let header_bytes = B64
        .decode(&file.header)
        .map_err(|_| Error::Invalid("This is not a Janus export file".into()))?;
    let header: ExportHeader = serde_json::from_slice(&header_bytes)
        .map_err(|_| Error::Invalid("This is not a Janus export file".into()))?;
    if header.format != EXPORT_FORMAT || header.kdf != "argon2id-v19" {
        return Err(Error::Invalid("This is not a Janus export file".into()));
    }
    if header.version != EXPORT_VERSION {
        return Err(Error::Invalid(format!(
            "Unsupported export version {}",
            header.version
        )));
    }
    header.params.validate()?;
    let salt = B64
        .decode(&header.salt)
        .map_err(|_| Error::Invalid("Damaged export file".into()))?;
    let kek = crypto::derive(password, &salt, header.params)?;
    let raw = Zeroizing::new(crypto::open(&kek, &file.wrapped_key, &header_bytes)?);
    let key = VaultKey::from_slice(&raw)?;
    let plaintext = Zeroizing::new(crypto::open(&key, &file.payload, &header_bytes)?);
    let contents: ExportContents = serde_json::from_slice(&plaintext)
        .map_err(|_| Error::Invalid("Damaged export file".into()))?;
    Ok(contents.items)
}
