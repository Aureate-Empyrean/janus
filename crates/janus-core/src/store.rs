//! Where the encrypted vault bytes live. Storage technology is Open in the architecture,
//! so the core depends only on this trait.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

pub trait VaultStore {
    fn load(&self) -> std::io::Result<Option<Vec<u8>>>;
    fn save(&mut self, bytes: &[u8]) -> std::io::Result<()>;
}

/// A single vault file, replaced atomically on every save.
pub struct FileStore {
    path: PathBuf,
}

impl FileStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

impl VaultStore for FileStore {
    fn load(&self) -> std::io::Result<Option<Vec<u8>>> {
        match fs::read(&self.path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn save(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        // Write a sibling file, flush it to disk, then rename over the old vault so a crash
        // leaves either the previous or the new vault, never a truncated one.
        let temp = self.path.with_extension("tmp");
        {
            let mut file = fs::File::create(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }
        fs::rename(&temp, &self.path)
    }
}

/// In-memory store for tests and previews.
#[derive(Default, Clone)]
pub struct MemoryStore {
    pub bytes: Option<Vec<u8>>,
}

impl VaultStore for MemoryStore {
    fn load(&self) -> std::io::Result<Option<Vec<u8>>> {
        Ok(self.bytes.clone())
    }

    fn save(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.bytes = Some(bytes.to_vec());
        Ok(())
    }
}
