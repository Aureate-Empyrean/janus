//! Janus vault core: items, the encrypted vault file and the lock/unlock lifecycle.
//!
//! DEVELOPMENT BUILD. The cryptographic design in `docs/SECURITY_DESIGN_DRAFT.md` is a
//! proposal that has not been reviewed. Do not store real secrets with this code.

mod crypto;
mod generate;
mod item;
mod store;

pub use crypto::KdfParams;
pub use generate::{generate_password, generated_entropy_bits};
pub use item::{
    ApiSecret, Identity, Item, ItemKind, ItemSummary, Login, PaymentCard, SecureNote,
    WifiCredential,
};
pub use store::{FileStore, MemoryStore, VaultStore};

use crypto::{Envelope, VaultKey};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

/// Minimum master password length accepted when creating a vault or changing the password.
pub const MIN_PASSWORD_CHARS: usize = 12;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("A vault already exists here")]
    AlreadyExists,
    #[error("No vault exists here yet")]
    NotFound,
    #[error("The vault is locked")]
    Locked,
    #[error("Wrong master password, or the vault file was modified")]
    Unlock,
    #[error("The master password must be at least {MIN_PASSWORD_CHARS} characters")]
    WeakPassword,
    #[error("The vault file is not a Janus vault this version can read: {0}")]
    Format(String),
    #[error("Item not found")]
    ItemNotFound,
    #[error("Item kind cannot be changed")]
    KindMismatch,
    #[error("Storage error: {0}")]
    Storage(#[from] std::io::Error),
    #[error("Cryptographic operation failed")]
    Crypto,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Plaintext vault contents. Only ever exists in memory while unlocked.
#[derive(Default, Serialize, Deserialize)]
struct Contents {
    items: Vec<Item>,
}

struct Unlocked {
    key: VaultKey,
    envelope: Envelope,
    contents: Contents,
}

/// A vault bound to one store. Locked until `unlock` or `create` succeeds.
pub struct Vault<S: VaultStore> {
    store: S,
    params: KdfParams,
    open: Option<Unlocked>,
}

impl<S: VaultStore> Vault<S> {
    pub fn new(store: S) -> Self {
        Self::with_params(store, KdfParams::default())
    }

    /// KDF parameters for newly created vaults; existing vaults keep their stored parameters.
    pub fn with_params(store: S, params: KdfParams) -> Self {
        Self {
            store,
            params,
            open: None,
        }
    }

    pub fn exists(&self) -> Result<bool> {
        Ok(self.store.load()?.is_some())
    }

    /// The underlying store (encrypted bytes only).
    pub fn store(&self) -> &S {
        &self.store
    }

    pub fn is_unlocked(&self) -> bool {
        self.open.is_some()
    }

    /// Creates a new empty vault and leaves it unlocked.
    pub fn create(&mut self, password: &str) -> Result<()> {
        check_password(password)?;
        if self.exists()? {
            return Err(Error::AlreadyExists);
        }
        let key = VaultKey::generate()?;
        let envelope = Envelope::wrap(&key, password, self.params)?;
        self.open = Some(Unlocked {
            key,
            envelope,
            contents: Contents::default(),
        });
        self.persist()
    }

    pub fn unlock(&mut self, password: &str) -> Result<()> {
        let bytes = self.store.load()?.ok_or(Error::NotFound)?;
        let envelope = Envelope::parse(&bytes)?;
        let key = envelope.unwrap_key(password)?;
        let plaintext = Zeroizing::new(envelope.open_payload(&key)?);
        let contents: Contents =
            serde_json::from_slice(&plaintext).map_err(|e| Error::Format(e.to_string()))?;
        self.open = Some(Unlocked {
            key,
            envelope,
            contents,
        });
        Ok(())
    }

    /// Drops the vault key and all decrypted items (both zeroize on drop).
    pub fn lock(&mut self) {
        self.open = None;
    }

    pub fn change_password(&mut self, current: &str, new: &str) -> Result<()> {
        check_password(new)?;
        let open = self.open.as_ref().ok_or(Error::Locked)?;
        // Re-derive from the stored envelope so a stolen unlocked session cannot rotate it blindly.
        open.envelope.unwrap_key(current)?;
        let envelope = Envelope::wrap(&open.key, new, self.params)?;
        self.open.as_mut().ok_or(Error::Locked)?.envelope = envelope;
        self.persist()
    }

    /// Item list without secret fields, safe for overview screens.
    pub fn list(&self) -> Result<Vec<ItemSummary>> {
        let open = self.open.as_ref().ok_or(Error::Locked)?;
        let mut items: Vec<ItemSummary> = open.contents.items.iter().map(Item::summary).collect();
        items.sort_by_key(|a| a.title.to_lowercase());
        Ok(items)
    }

    pub fn get(&self, id: Uuid) -> Result<Item> {
        let open = self.open.as_ref().ok_or(Error::Locked)?;
        open.contents
            .items
            .iter()
            .find(|i| i.id == id)
            .cloned()
            .ok_or(Error::ItemNotFound)
    }

    pub fn add(&mut self, kind: ItemKind) -> Result<Uuid> {
        let open = self.open.as_mut().ok_or(Error::Locked)?;
        let item = Item::new(kind);
        let id = item.id;
        open.contents.items.push(item);
        self.persist()?;
        Ok(id)
    }

    pub fn update(&mut self, id: Uuid, kind: ItemKind) -> Result<()> {
        let open = self.open.as_mut().ok_or(Error::Locked)?;
        let item = open
            .contents
            .items
            .iter_mut()
            .find(|i| i.id == id)
            .ok_or(Error::ItemNotFound)?;
        item.replace(kind)?;
        self.persist()
    }

    pub fn delete(&mut self, id: Uuid) -> Result<()> {
        let open = self.open.as_mut().ok_or(Error::Locked)?;
        let before = open.contents.items.len();
        open.contents.items.retain(|i| i.id != id);
        if open.contents.items.len() == before {
            return Err(Error::ItemNotFound);
        }
        self.persist()
    }

    fn persist(&mut self) -> Result<()> {
        let open = self.open.as_mut().ok_or(Error::Locked)?;
        let plaintext =
            Zeroizing::new(serde_json::to_vec(&open.contents).map_err(|_| Error::Crypto)?);
        open.envelope.seal_payload(&open.key, &plaintext)?;
        self.store.save(&open.envelope.to_bytes()?)?;
        Ok(())
    }
}

fn check_password(password: &str) -> Result<()> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(Error::WeakPassword);
    }
    Ok(())
}
