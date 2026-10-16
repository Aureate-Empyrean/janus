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

/// A payment card record (not a renamed Login).
#[derive(Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct PaymentCard {
    pub title: String,
    pub cardholder: String,
    pub number: String,
    /// Free text such as "08/29"; formats vary by issuer.
    pub expiry: String,
    pub security_code: String,
    pub pin: String,
    pub notes: String,
}

/// Passport, national ID, driving licence or another sensitive document.
/// Jurisdiction-specific schemas are deliberately not modelled.
#[derive(Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct Identity {
    pub title: String,
    /// passport, national_id, driving_licence or other.
    pub document_type: String,
    pub full_name: String,
    pub document_number: String,
    pub issuing_authority: String,
    pub country: String,
    pub issued_on: String,
    pub expires_on: String,
    pub notes: String,
}

#[derive(Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct WifiCredential {
    pub title: String,
    pub ssid: String,
    pub password: String,
    /// WPA3, WPA2, WEP, open or other.
    pub security: String,
    pub notes: String,
}

/// API keys, access tokens, client secrets and other service credentials kept by the user.
#[derive(Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct ApiSecret {
    pub title: String,
    pub service: String,
    pub key_id: String,
    pub secret: String,
    pub notes: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ItemKind {
    Login(Login),
    SecureNote(SecureNote),
    PaymentCard(PaymentCard),
    Identity(Identity),
    Wifi(WifiCredential),
    ApiSecret(ApiSecret),
}

impl ItemKind {
    fn title(&self) -> &str {
        match self {
            ItemKind::Login(i) => &i.title,
            ItemKind::SecureNote(i) => &i.title,
            ItemKind::PaymentCard(i) => &i.title,
            ItemKind::Identity(i) => &i.title,
            ItemKind::Wifi(i) => &i.title,
            ItemKind::ApiSecret(i) => &i.title,
        }
    }

    fn type_name(&self) -> &'static str {
        match self {
            ItemKind::Login(_) => "login",
            ItemKind::SecureNote(_) => "secure_note",
            ItemKind::PaymentCard(_) => "payment_card",
            ItemKind::Identity(_) => "identity",
            ItemKind::Wifi(_) => "wifi",
            ItemKind::ApiSecret(_) => "api_secret",
        }
    }

    /// Non-secret context for overview lists. Never a password, full number or secret.
    fn subtitle(&self) -> String {
        match self {
            ItemKind::Login(i) => i.username.clone(),
            ItemKind::SecureNote(_) => String::new(),
            ItemKind::PaymentCard(i) => {
                let digits: Vec<char> = i.number.chars().filter(char::is_ascii_digit).collect();
                if digits.len() >= 8 {
                    format!(
                        "•••• {}",
                        digits[digits.len() - 4..].iter().collect::<String>()
                    )
                } else {
                    String::new()
                }
            }
            ItemKind::Identity(i) => match i.document_type.as_str() {
                "passport" => "Passport".into(),
                "national_id" => "National ID".into(),
                "driving_licence" => "Driving licence".into(),
                _ => "Document".into(),
            },
            ItemKind::Wifi(i) => i.ssid.clone(),
            ItemKind::ApiSecret(i) => i.service.clone(),
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
        ItemSummary {
            id: self.id,
            kind: self.kind.type_name(),
            title: self.kind.title().to_owned(),
            subtitle: self.kind.subtitle(),
            updated_at: self.updated_at,
        }
    }
}
