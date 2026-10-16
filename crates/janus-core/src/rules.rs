//! Field rules for every item type: normalization (e.g. card number spacing, expiry
//! format) and validation with per-field messages. The core is the single source of these
//! rules; the interface asks the core instead of duplicating them.

use crate::item::ItemKind;
use serde::Serialize;
use time::{Date, format_description::well_known::Iso8601};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FieldError {
    pub field: &'static str,
    pub message: String,
}

pub const TITLE_MAX: usize = 200;
pub const NOTES_MAX: usize = 10_000;
pub const SECURE_NOTE_MAX: usize = 100_000;

fn chars(value: &str) -> usize {
    value.chars().count()
}

fn digits_only(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect()
}

/// Luhn checksum used by payment card numbers (ISO/IEC 7812).
fn luhn(digits: &str) -> bool {
    let mut sum = 0;
    for (i, c) in digits.chars().rev().enumerate() {
        let Some(mut d) = c.to_digit(10) else {
            return false;
        };
        if i % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    sum % 10 == 0
}

fn err(errors: &mut Vec<FieldError>, field: &'static str, message: &str) {
    errors.push(FieldError {
        field,
        message: message.into(),
    });
}

fn max(errors: &mut Vec<FieldError>, field: &'static str, value: &str, limit: usize) {
    if chars(value) > limit {
        err(errors, field, &format!("At most {limit} characters"));
    }
}

fn parse_date(value: &str) -> Option<Date> {
    Date::parse(value, &Iso8601::DATE).ok()
}

impl ItemKind {
    /// Canonical forms: trimmed titles, card numbers without separators, expiry as MM/YY.
    pub fn normalize(&mut self) {
        match self {
            ItemKind::Login(i) => {
                i.title = i.title.trim().into();
                i.username = i.username.trim().into();
                i.urls = i
                    .urls
                    .iter()
                    .map(|u| u.trim().to_owned())
                    .filter(|u| !u.is_empty())
                    .collect();
                i.totp = i.totp.trim().into();
            }
            ItemKind::SecureNote(i) => i.title = i.title.trim().into(),
            ItemKind::PaymentCard(i) => {
                i.title = i.title.trim().into();
                i.cardholder = i.cardholder.trim().into();
                i.number = digits_only(&i.number);
                i.security_code = i.security_code.trim().into();
                i.pin = i.pin.trim().into();
                let expiry: String = i.expiry.chars().filter(|c| !c.is_whitespace()).collect();
                if let Some((m, y)) = expiry.split_once(['/', '-', '.'])
                    && m.len() <= 2
                    && (y.len() == 2 || y.len() == 4)
                    && m.chars().chain(y.chars()).all(|c| c.is_ascii_digit())
                {
                    i.expiry = format!("{m:0>2}/{}", &y[y.len() - 2..]);
                } else {
                    i.expiry = expiry;
                }
            }
            ItemKind::Identity(i) => {
                i.title = i.title.trim().into();
                i.full_name = i.full_name.trim().into();
                i.document_number = i.document_number.trim().to_uppercase();
                i.issuing_authority = i.issuing_authority.trim().into();
                i.country = i.country.trim().into();
            }
            ItemKind::Wifi(i) => {
                i.title = i.title.trim().into();
            }
            ItemKind::ApiSecret(i) => {
                i.title = i.title.trim().into();
                i.service = i.service.trim().into();
                i.key_id = i.key_id.trim().into();
            }
        }
    }

    /// Every rule violation, field by field. Empty optional fields are always allowed.
    pub fn check(&self) -> Vec<FieldError> {
        let mut errors = Vec::new();
        let title = match self {
            ItemKind::Login(i) => &i.title,
            ItemKind::SecureNote(i) => &i.title,
            ItemKind::PaymentCard(i) => &i.title,
            ItemKind::Identity(i) => &i.title,
            ItemKind::Wifi(i) => &i.title,
            ItemKind::ApiSecret(i) => &i.title,
        };
        if title.trim().is_empty() {
            err(&mut errors, "title", "Give the item a title");
        } else if chars(title) > TITLE_MAX {
            err(&mut errors, "title", "At most 200 characters");
        }
        match self {
            ItemKind::Login(i) => {
                max(&mut errors, "username", &i.username, 256);
                max(&mut errors, "password", &i.password, 1024);
                max(&mut errors, "notes", &i.notes, NOTES_MAX);
                if i.urls.len() > 20 {
                    err(&mut errors, "urls", "At most 20 websites");
                }
                if i.urls
                    .iter()
                    .any(|u| chars(u) > 2048 || u.chars().any(char::is_whitespace))
                {
                    err(&mut errors, "urls", "Enter a web address without spaces");
                }
                if !i.totp.is_empty() && crate::Totp::parse(&i.totp).is_err() {
                    err(
                        &mut errors,
                        "totp",
                        "Not a valid authenticator key (Base32 or otpauth:// link)",
                    );
                }
            }
            ItemKind::SecureNote(i) => max(&mut errors, "content", &i.content, SECURE_NOTE_MAX),
            ItemKind::PaymentCard(i) => {
                max(&mut errors, "cardholder", &i.cardholder, 100);
                max(&mut errors, "notes", &i.notes, NOTES_MAX);
                if !i.number.is_empty() {
                    if !i.number.chars().all(|c| c.is_ascii_digit()) {
                        err(&mut errors, "number", "Digits only");
                    } else if !(12..=19).contains(&i.number.len()) {
                        err(&mut errors, "number", "Card numbers have 12 to 19 digits");
                    } else if !luhn(&i.number) {
                        err(
                            &mut errors,
                            "number",
                            "This card number fails its checksum; check for a typo",
                        );
                    }
                }
                if !i.expiry.is_empty() {
                    let valid = i.expiry.len() == 5
                        && i.expiry.as_bytes()[2] == b'/'
                        && matches!(i.expiry[..2].parse::<u8>(), Ok(1..=12))
                        && i.expiry[3..].chars().all(|c| c.is_ascii_digit());
                    if !valid {
                        err(&mut errors, "expiry", "Use MM/YY, for example 08/29");
                    }
                }
                let digits = |v: &str, lo: usize, hi: usize| {
                    v.is_empty()
                        || (v.chars().all(|c| c.is_ascii_digit()) && (lo..=hi).contains(&v.len()))
                };
                if !digits(&i.security_code, 3, 4) {
                    err(&mut errors, "security_code", "3 or 4 digits");
                }
                if !digits(&i.pin, 4, 12) {
                    err(&mut errors, "pin", "4 to 12 digits");
                }
            }
            ItemKind::Identity(i) => {
                if !["passport", "national_id", "driving_licence", "other"]
                    .contains(&i.document_type.as_str())
                {
                    err(&mut errors, "document_type", "Choose a document type");
                }
                max(&mut errors, "full_name", &i.full_name, 200);
                max(&mut errors, "issuing_authority", &i.issuing_authority, 200);
                max(&mut errors, "country", &i.country, 60);
                max(&mut errors, "notes", &i.notes, NOTES_MAX);
                if chars(&i.document_number) > 40
                    || !i
                        .document_number
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '/')
                {
                    err(
                        &mut errors,
                        "document_number",
                        "Up to 40 letters, digits, spaces, - or /",
                    );
                }
                let issued = (!i.issued_on.is_empty()).then(|| parse_date(&i.issued_on));
                let expires = (!i.expires_on.is_empty()).then(|| parse_date(&i.expires_on));
                if issued == Some(None) {
                    err(&mut errors, "issued_on", "Not a valid date");
                }
                if expires == Some(None) {
                    err(&mut errors, "expires_on", "Not a valid date");
                }
                if let (Some(Some(a)), Some(Some(b))) = (issued, expires)
                    && b < a
                {
                    err(&mut errors, "expires_on", "Expires before it was issued");
                }
            }
            ItemKind::Wifi(i) => {
                max(&mut errors, "notes", &i.notes, NOTES_MAX);
                if i.ssid.is_empty() {
                    err(&mut errors, "ssid", "Enter the network name");
                } else if i.ssid.len() > 32 {
                    err(&mut errors, "ssid", "Network names are at most 32 bytes");
                }
                let hex = |v: &str| v.chars().all(|c| c.is_ascii_hexdigit());
                let ascii = |v: &str| v.chars().all(|c| (' '..='~').contains(&c));
                let p = i.password.as_str();
                match i.security.as_str() {
                    "WPA3" | "WPA2" => {
                        if !((8..=63).contains(&p.len()) && ascii(p) || p.len() == 64 && hex(p)) {
                            err(
                                &mut errors,
                                "password",
                                "WPA passwords are 8 to 63 characters, or 64 hex digits",
                            );
                        }
                    }
                    "WEP" => {
                        if !(matches!(p.len(), 5 | 13) && ascii(p)
                            || matches!(p.len(), 10 | 26) && hex(p))
                        {
                            err(
                                &mut errors,
                                "password",
                                "WEP keys are 5 or 13 characters, or 10 or 26 hex digits",
                            );
                        }
                    }
                    "open" => {
                        if !p.is_empty() {
                            err(&mut errors, "password", "Open networks have no password");
                        }
                    }
                    "other" => {
                        if chars(p) > 256 {
                            err(&mut errors, "password", "At most 256 characters");
                        }
                    }
                    _ => err(&mut errors, "security", "Choose the security type"),
                }
            }
            ItemKind::ApiSecret(i) => {
                max(&mut errors, "service", &i.service, 100);
                max(&mut errors, "key_id", &i.key_id, 200);
                max(&mut errors, "secret", &i.secret, 8192);
                max(&mut errors, "notes", &i.notes, NOTES_MAX);
            }
        }
        errors
    }

    /// For imported data: normalizes, then moves every value that breaks a rule into the
    /// notes (labelled with the reason) so nothing is lost and the item still saves.
    /// Returns one message per moved value.
    pub(crate) fn sanitize(&mut self) -> Vec<String> {
        self.normalize();
        let mut moved = Vec::new();
        for error in self.check() {
            match error.field {
                "title" => {
                    let current = self.title_text();
                    self.set_title(if current.trim().is_empty() {
                        "Imported item"
                    } else {
                        &current
                    });
                }
                "document_type" => {
                    if let ItemKind::Identity(i) = self {
                        i.document_type = "other".into();
                    }
                }
                "security" => {
                    if let ItemKind::Wifi(i) = self {
                        i.security = "other".into();
                    }
                }
                field => {
                    if let Some(value) = self.take_field(field).filter(|v| !v.is_empty()) {
                        let line = format!("{field} (kept here: {}): {value}", error.message);
                        let notes = self.notes_mut();
                        if !notes.is_empty() {
                            notes.push('\n');
                        }
                        notes.push_str(&line);
                        moved.push(format!("{field}: {}", error.message));
                    }
                }
            }
        }
        // A WEP/WPA network whose password moved to the notes is no longer checkable.
        if let ItemKind::Wifi(i) = self
            && i.password.is_empty()
            && i.security != "open"
        {
            i.security = "other".into();
        }
        // Anything still invalid (e.g. an over-long note) is cut rather than failing the import.
        for error in self.check() {
            let limit = if error.field == "content" {
                SECURE_NOTE_MAX
            } else {
                NOTES_MAX
            };
            let notes = self.notes_mut();
            if error.field == "notes" || error.field == "content" {
                *notes = notes.chars().take(limit).collect();
                moved.push(format!("{}: shortened to {limit} characters", error.field));
            }
        }
        moved
    }

    fn title_text(&self) -> String {
        match self {
            ItemKind::Login(i) => i.title.clone(),
            ItemKind::SecureNote(i) => i.title.clone(),
            ItemKind::PaymentCard(i) => i.title.clone(),
            ItemKind::Identity(i) => i.title.clone(),
            ItemKind::Wifi(i) => i.title.clone(),
            ItemKind::ApiSecret(i) => i.title.clone(),
        }
    }

    fn set_title(&mut self, title: &str) {
        let slot = match self {
            ItemKind::Login(i) => &mut i.title,
            ItemKind::SecureNote(i) => &mut i.title,
            ItemKind::PaymentCard(i) => &mut i.title,
            ItemKind::Identity(i) => &mut i.title,
            ItemKind::Wifi(i) => &mut i.title,
            ItemKind::ApiSecret(i) => &mut i.title,
        };
        *slot = title.chars().take(TITLE_MAX).collect();
    }

    fn notes_mut(&mut self) -> &mut String {
        match self {
            ItemKind::Login(i) => &mut i.notes,
            ItemKind::SecureNote(i) => &mut i.content,
            ItemKind::PaymentCard(i) => &mut i.notes,
            ItemKind::Identity(i) => &mut i.notes,
            ItemKind::Wifi(i) => &mut i.notes,
            ItemKind::ApiSecret(i) => &mut i.notes,
        }
    }

    /// Removes a field's value (used by imports to move a rejected value into the notes).
    pub(crate) fn take_field(&mut self, field: &str) -> Option<String> {
        let slot = match (self, field) {
            (ItemKind::Login(i), "username") => &mut i.username,
            (ItemKind::Login(i), "password") => &mut i.password,
            (ItemKind::Login(i), "totp") => &mut i.totp,
            (ItemKind::Login(i), "urls") => return Some(std::mem::take(&mut i.urls).join("\n")),
            (ItemKind::PaymentCard(i), "cardholder") => &mut i.cardholder,
            (ItemKind::PaymentCard(i), "number") => &mut i.number,
            (ItemKind::PaymentCard(i), "expiry") => &mut i.expiry,
            (ItemKind::PaymentCard(i), "security_code") => &mut i.security_code,
            (ItemKind::PaymentCard(i), "pin") => &mut i.pin,
            (ItemKind::Identity(i), "document_number") => &mut i.document_number,
            (ItemKind::Identity(i), "issued_on") => &mut i.issued_on,
            (ItemKind::Identity(i), "expires_on") => &mut i.expires_on,
            (ItemKind::Identity(i), "full_name") => &mut i.full_name,
            (ItemKind::Identity(i), "country") => &mut i.country,
            (ItemKind::Identity(i), "issuing_authority") => &mut i.issuing_authority,
            (ItemKind::Wifi(i), "password") => &mut i.password,
            (ItemKind::Wifi(i), "ssid") => &mut i.ssid,
            (ItemKind::ApiSecret(i), "service") => &mut i.service,
            (ItemKind::ApiSecret(i), "key_id") => &mut i.key_id,
            _ => return None,
        };
        Some(std::mem::take(slot))
    }
}

#[cfg(test)]
mod tests {
    use super::luhn;

    #[test]
    fn luhn_checksum() {
        assert!(luhn("4111111111111111"));
        assert!(luhn("5555555555554444"));
        assert!(luhn("378282246310005"));
        assert!(!luhn("4111111111111112"));
    }
}
