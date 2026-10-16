use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct Login {
    pub title: String,
    pub username: String,
    pub password: String,
    pub urls: Vec<String>,
    pub notes: String,
}

#[derive(Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct SecureNote {
    pub title: String,
    pub content: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ItemKind {
    Login(Login),
    SecureNote(SecureNote),
}

impl ItemKind {
    fn title(&self) -> &str {
        match self {
            ItemKind::Login(l) => &l.title,
            ItemKind::SecureNote(n) => &n.title,
        }
    }

    fn type_name(&self) -> &'static str {
        match self {
            ItemKind::Login(_) => "login",
            ItemKind::SecureNote(_) => "secure_note",
        }
    }
}

/// A vault item with a stable UUID identity.
#[derive(Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    #[serde(flatten)]
    pub kind: ItemKind,
}

/// Overview data: never contains passwords or note bodies.
#[derive(Clone, Debug, Serialize)]
pub struct ItemSummary {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub title: String,
    pub subtitle: String,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

impl Item {
    pub(crate) fn new(kind: ItemKind) -> Self {
        let now = OffsetDateTime::now_utc();
        Self {
            id: Uuid::new_v4(),
            created_at: now,
            updated_at: now,
            kind,
        }
    }

    pub(crate) fn replace(&mut self, kind: ItemKind) -> Result<()> {
        if self.kind.type_name() != kind.type_name() {
            return Err(Error::KindMismatch);
        }
        self.kind = kind;
        self.updated_at = OffsetDateTime::now_utc();
        Ok(())
    }

    pub fn summary(&self) -> ItemSummary {
        let subtitle = match &self.kind {
            ItemKind::Login(l) => l.username.clone(),
            ItemKind::SecureNote(_) => String::new(),
        };
        ItemSummary {
            id: self.id,
            kind: self.kind.type_name(),
            title: self.kind.title().to_owned(),
            subtitle,
            updated_at: self.updated_at,
        }
    }
}
