//! Import from other password managers' exports. Those files are plaintext; Janus reads
//! them in memory and cannot delete or protect the source file (see the security draft).
//!
//! Nothing is dropped silently: fields without a Janus counterpart are appended to the
//! item's notes and counted in `ImportPlan::kept_in_notes`.

use crate::item::{
    Identity, Item, ItemKind, ItemMeta, Login, PaymentCard, SecretChange, SecureNote,
};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use time::OffsetDateTime;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportFormat {
    BitwardenJson,
    BrowserCsv,
}

/// Parsed items with new identities, ready to review and add.
pub struct ImportPlan {
    pub items: Vec<Item>,
    pub warnings: Vec<String>,
    pub kept_in_notes: usize,
}

pub fn parse(format: ImportFormat, bytes: &[u8]) -> Result<ImportPlan> {
    match format {
        ImportFormat::BitwardenJson => bitwarden(bytes),
        ImportFormat::BrowserCsv => browser_csv(bytes),
    }
}

struct Builder {
    plan: ImportPlan,
}

impl Builder {
    fn new() -> Self {
        Self {
            plan: ImportPlan {
                items: Vec::new(),
                warnings: Vec::new(),
                kept_in_notes: 0,
            },
        }
    }

    /// Appends unmapped fields to the notes text, as "Name: value" lines.
    fn notes(&mut self, notes: &str, extra: &[(String, String)]) -> String {
        let extra: Vec<String> = extra
            .iter()
            .filter(|(_, v)| !v.trim().is_empty())
            .map(|(k, v)| format!("{k}: {v}"))
            .collect();
        self.plan.kept_in_notes += extra.len();
        match (notes.trim().is_empty(), extra.is_empty()) {
            (_, true) => notes.to_owned(),
            (true, false) => extra.join("\n"),
            (false, false) => format!("{notes}\n\n{}", extra.join("\n")),
        }
    }

    fn push(
        &mut self,
        mut kind: ItemKind,
        meta: ItemMeta,
        history: Vec<SecretChange>,
    ) -> Result<()> {
        let title = kind.summary_title().to_owned();
        for moved in kind.sanitize() {
            self.plan
                .warnings
                .push(format!("\"{title}\": {moved}; value kept in the notes"));
            self.plan.kept_in_notes += 1;
        }
        kind.validate()?;
        let mut item = Item::new(kind);
        item.set_meta(meta.normalized()?);
        item.history = history;
        item.history.truncate(crate::item::HISTORY_LIMIT);
        self.plan.items.push(item);
        Ok(())
    }
}

fn s(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(v)) => v.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn bitwarden(bytes: &[u8]) -> Result<ImportPlan> {
    let not_bitwarden = || Error::Invalid("This is not a Bitwarden JSON export".into());
    let root: Value = serde_json::from_slice(bytes).map_err(|_| not_bitwarden())?;
    if root.get("encrypted").and_then(Value::as_bool) == Some(true) {
        return Err(Error::Invalid(
            "This Bitwarden export is encrypted. Export again as unencrypted JSON, import it, then delete that file.".into(),
        ));
    }
    let items = root
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(not_bitwarden)?;
    let folders: HashMap<String, String> = root
        .get("folders")
        .and_then(Value::as_array)
        .map(|f| f.iter().map(|f| (s(f, "id"), s(f, "name"))).collect())
        .unwrap_or_default();
    let mut b = Builder::new();
    for raw in items {
        let title = s(raw, "name");
        let meta = ItemMeta {
            folder: folders
                .get(&s(raw, "folderId"))
                .cloned()
                .unwrap_or_default(),
            tags: vec![],
            favorite: raw
                .get("favorite")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        let mut extra: Vec<(String, String)> = raw
            .get("fields")
            .and_then(Value::as_array)
            .map(|f| f.iter().map(|f| (s(f, "name"), s(f, "value"))).collect())
            .unwrap_or_default();
        let notes = s(raw, "notes");
        let kind = raw.get("type").and_then(Value::as_u64).unwrap_or(0);
        match kind {
            1 => {
                let login = raw.get("login").cloned().unwrap_or(Value::Null);
                let urls = login
                    .get("uris")
                    .and_then(Value::as_array)
                    .map(|u| {
                        u.iter()
                            .map(|u| s(u, "uri"))
                            .filter(|u| !u.is_empty())
                            .collect()
                    })
                    .unwrap_or_default();
                let history = raw
                    .get("passwordHistory")
                    .and_then(Value::as_array)
                    .map(|h| {
                        h.iter()
                            .map(|h| SecretChange {
                                field: "password".into(),
                                value: s(h, "password"),
                                replaced_at: OffsetDateTime::parse(
                                    &s(h, "lastUsedDate"),
                                    &time::format_description::well_known::Rfc3339,
                                )
                                .unwrap_or(OffsetDateTime::UNIX_EPOCH),
                            })
                            .filter(|c| !c.value.is_empty())
                            .collect()
                    })
                    .unwrap_or_default();
                let notes = b.notes(&notes, &extra);
                b.push(
                    ItemKind::Login(Login {
                        title,
                        username: s(&login, "username"),
                        password: s(&login, "password"),
                        urls,
                        notes,
                        totp: s(&login, "totp"),
                    }),
                    meta,
                    history,
                )?;
            }
            2 => {
                let content = b.notes(&notes, &extra);
                b.push(
                    ItemKind::SecureNote(SecureNote { title, content }),
                    meta,
                    vec![],
                )?;
            }
            3 => {
                let card = raw.get("card").cloned().unwrap_or(Value::Null);
                let (month, year) = (s(&card, "expMonth"), s(&card, "expYear"));
                let expiry = match (month.is_empty(), year.is_empty()) {
                    (false, false) => {
                        format!("{month:0>2}/{}", &year[year.len().saturating_sub(2)..])
                    }
                    _ => format!("{month}{year}"),
                };
                extra.insert(0, ("Brand".into(), s(&card, "brand")));
                let notes = b.notes(&notes, &extra);
                b.push(
                    ItemKind::PaymentCard(PaymentCard {
                        title,
                        cardholder: s(&card, "cardholderName"),
                        number: s(&card, "number"),
                        expiry,
                        security_code: s(&card, "code"),
                        pin: String::new(),
                        notes,
                    }),
                    meta,
                    vec![],
                )?;
            }
            4 => {
                let id = raw.get("identity").cloned().unwrap_or(Value::Null);
                let (document_type, number_key) = [
                    ("passport", "passportNumber"),
                    ("driving_licence", "licenseNumber"),
                    ("national_id", "ssn"),
                ]
                .into_iter()
                .find(|(_, key)| !s(&id, key).is_empty())
                .unwrap_or(("other", ""));
                let number = s(&id, number_key);
                let full_name = ["title", "firstName", "middleName", "lastName"]
                    .iter()
                    .map(|k| s(&id, k))
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                let used = [
                    "title",
                    "firstName",
                    "middleName",
                    "lastName",
                    "country",
                    number_key,
                ];
                let mut rest: Vec<(String, String)> = id
                    .as_object()
                    .map(|o| {
                        o.keys()
                            .filter(|k| !used.contains(&k.as_str()))
                            .map(|k| (k.clone(), s(&id, k)))
                            .collect()
                    })
                    .unwrap_or_default();
                rest.extend(extra);
                let notes = b.notes(&notes, &rest);
                b.push(
                    ItemKind::Identity(Identity {
                        title,
                        document_type: document_type.into(),
                        full_name,
                        document_number: number,
                        issuing_authority: String::new(),
                        country: s(&id, "country"),
                        issued_on: String::new(),
                        expires_on: String::new(),
                        notes,
                    }),
                    meta,
                    vec![],
                )?;
            }
            other => {
                // Unknown or newer types (e.g. SSH keys): keep everything as a secure note.
                b.plan.warnings.push(format!(
                    "\"{title}\": item type {other} has no Janus counterpart yet; kept as a secure note"
                ));
                let content = serde_json::to_string_pretty(raw).unwrap_or_default();
                b.push(
                    ItemKind::SecureNote(SecureNote { title, content }),
                    meta,
                    vec![],
                )?;
            }
        }
    }
    Ok(b.plan)
}

fn browser_csv(bytes: &[u8]) -> Result<ImportPlan> {
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(bytes);
    let headers: Vec<String> = reader
        .headers()
        .map_err(|_| Error::Invalid("This is not a CSV file".into()))?
        .iter()
        .map(|h| h.trim().to_lowercase())
        .collect();
    let find = |names: &[&str]| headers.iter().position(|h| names.contains(&h.as_str()));
    let (title, url, user, pass, note) = (
        find(&["name", "title"]),
        find(&["url", "login_uri", "website"]),
        find(&["username", "login", "login_username", "email"]),
        find(&["password", "login_password"]),
        find(&["note", "notes", "extra", "comments"]),
    );
    let Some(pass) = pass else {
        return Err(Error::Invalid(
            "The CSV has no password column; is it a browser password export?".into(),
        ));
    };
    let mapped = [title, url, user, Some(pass), note];
    let mut b = Builder::new();
    for (row, record) in reader.records().enumerate() {
        let record = record.map_err(|e| Error::Invalid(format!("CSV row {}: {e}", row + 2)))?;
        let get = |i: Option<usize>| i.and_then(|i| record.get(i)).unwrap_or("").to_owned();
        let url_value = get(url);
        let title_value = match get(title) {
            t if !t.is_empty() => t,
            _ => host(&url_value).unwrap_or_else(|| "Imported login".into()),
        };
        let extra: Vec<(String, String)> = headers
            .iter()
            .enumerate()
            .filter(|(i, _)| !mapped.contains(&Some(*i)))
            .map(|(i, h)| (h.clone(), record.get(i).unwrap_or("").to_owned()))
            .collect();
        let notes = b.notes(&get(note), &extra);
        b.push(
            ItemKind::Login(Login {
                title: title_value,
                username: get(user),
                password: get(Some(pass)),
                urls: if url_value.is_empty() {
                    vec![]
                } else {
                    vec![url_value]
                },
                notes,
                totp: String::new(),
            }),
            ItemMeta::default(),
            vec![],
        )?;
    }
    Ok(b.plan)
}

fn host(url: &str) -> Option<String> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let host = rest
        .split(['/', '?', '#'])
        .next()?
        .trim_start_matches("www.");
    (!host.is_empty()).then(|| host.to_owned())
}
