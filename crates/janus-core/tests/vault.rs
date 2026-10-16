use janus_core::{
    Error, FileStore, ItemKind, KdfParams, Login, MemoryStore, SecureNote, Vault, VaultStore,
};

const PASSWORD: &str = "correct horse battery staple";

fn vault<S: VaultStore>(store: S) -> Vault<S> {
    Vault::with_params(store, KdfParams::insecure_for_tests())
}

fn login(title: &str, password: &str) -> ItemKind {
    ItemKind::Login(Login {
        title: title.into(),
        username: "adrian".into(),
        password: password.into(),
        urls: vec!["https://example.org".into()],
        notes: String::new(),
        totp: String::new(),
    })
}

#[test]
fn roundtrip_through_file_and_fresh_instance() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vault.janus");
    let mut v = vault(FileStore::new(&path));
    assert!(!v.exists().unwrap());
    v.create(PASSWORD).unwrap();
    let id = v.add(login("Mail", "s3cret-value")).unwrap();
    v.add(ItemKind::SecureNote(SecureNote {
        title: "Recovery".into(),
        content: "codes".into(),
    }))
    .unwrap();

    let mut again = vault(FileStore::new(&path));
    assert!(!again.is_unlocked());
    again.unlock(PASSWORD).unwrap();
    let titles: Vec<_> = again.list().unwrap().into_iter().map(|s| s.title).collect();
    assert_eq!(titles, ["Mail", "Recovery"]);
    match again.get(id).unwrap().kind {
        ItemKind::Login(l) => assert_eq!(l.password, "s3cret-value"),
        _ => panic!("wrong kind"),
    }
    assert!(!dir.path().join("vault.tmp").exists());
}

#[test]
fn file_contains_no_plaintext() {
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    v.add(login("Bank of Example", "hunter2-plaintext"))
        .unwrap();
    let bytes = String::from_utf8(v_bytes(&v)).unwrap();
    for secret in [
        "Bank of Example",
        "hunter2-plaintext",
        "adrian",
        "example.org",
        PASSWORD,
    ] {
        assert!(
            !bytes.contains(secret),
            "{secret} leaked into the vault file"
        );
    }
}

fn v_bytes(v: &Vault<MemoryStore>) -> Vec<u8> {
    v.store().bytes.clone().unwrap()
}

#[test]
fn wrong_password_and_weak_password() {
    let mut v = vault(MemoryStore::default());
    assert!(matches!(v.create("short"), Err(Error::WeakPassword)));
    v.create(PASSWORD).unwrap();
    assert!(matches!(v.create(PASSWORD), Err(Error::AlreadyExists)));
    v.lock();
    assert!(matches!(
        v.unlock("correct horse battery stapler"),
        Err(Error::Unlock)
    ));
    assert!(!v.is_unlocked());
    v.unlock(PASSWORD).unwrap();
}

#[test]
fn lock_drops_access() {
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    let id = v.add(login("Mail", "x")).unwrap();
    v.lock();
    assert!(matches!(v.list(), Err(Error::Locked)));
    assert!(matches!(v.get(id), Err(Error::Locked)));
    assert!(matches!(v.add(login("New", "y")), Err(Error::Locked)));
}

#[test]
fn tampering_is_detected() {
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    v.add(login("Mail", "x")).unwrap();
    let original: serde_json::Value = serde_json::from_slice(&v_bytes(&v)).unwrap();

    let reopen = |value: &serde_json::Value| {
        let mut t = vault(MemoryStore {
            bytes: Some(serde_json::to_vec(value).unwrap()),
        });
        t.unlock(PASSWORD)
    };
    assert!(reopen(&original).is_ok());

    // Flip one ciphertext character of the contents.
    let mut payload = original.clone();
    let ct = payload["payload"]["ciphertext"]
        .as_str()
        .unwrap()
        .to_owned();
    let flipped = if ct.starts_with('A') { "B" } else { "A" }.to_owned() + &ct[1..];
    payload["payload"]["ciphertext"] = flipped.into();
    assert!(matches!(reopen(&payload), Err(Error::Unlock)));

    // Header values are authenticated: changing KDF parameters must not silently pass.
    let mut params = original.clone();
    params["header"]["params"]["iterations"] = 2.into();
    assert!(matches!(reopen(&params), Err(Error::Unlock)));

    // Trivially weak parameters are refused before any derivation.
    let mut weak = original.clone();
    weak["header"]["params"]["memory_kib"] = 8.into();
    assert!(matches!(reopen(&weak), Err(Error::Format(_))));

    let mut other = original;
    other["header"]["format"] = "something-else".into();
    assert!(matches!(reopen(&other), Err(Error::Format(_))));
}

#[test]
fn change_password_requires_current() {
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    v.add(login("Mail", "x")).unwrap();
    assert!(matches!(
        v.change_password("not the password", "a brand new passphrase"),
        Err(Error::Unlock)
    ));
    v.change_password(PASSWORD, "a brand new passphrase")
        .unwrap();
    v.lock();
    assert!(matches!(v.unlock(PASSWORD), Err(Error::Unlock)));
    v.unlock("a brand new passphrase").unwrap();
    assert_eq!(v.list().unwrap().len(), 1);
}

#[test]
fn summaries_hide_secrets_and_kind_is_stable() {
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    let id = v.add(login("Mail", "never-in-summary")).unwrap();
    let json = serde_json::to_string(&v.list().unwrap()).unwrap();
    assert!(!json.contains("never-in-summary"));
    assert!(json.contains("\"type\":\"login\""));
    let note = ItemKind::SecureNote(SecureNote {
        title: "n".into(),
        content: "c".into(),
    });
    assert!(matches!(v.update(id, note), Err(Error::KindMismatch)));
    v.update(id, login("Mail 2", "z")).unwrap();
    v.delete(id).unwrap();
    assert!(matches!(v.delete(id), Err(Error::ItemNotFound)));
}

#[test]
fn generated_passwords_are_long_varied_and_bounded() {
    use janus_core::{generate_password, generated_entropy_bits};
    let a = generate_password(24, true).unwrap();
    let b = generate_password(24, true).unwrap();
    assert_eq!(a.chars().count(), 24);
    assert_ne!(*a, *b);
    assert!(!a.contains(['0', 'O', '1', 'l', 'I']));
    let plain = generate_password(64, false).unwrap();
    assert!(plain.chars().all(|c| c.is_ascii_alphanumeric()));
    assert!(generate_password(8, true).is_err());
    assert!(generated_entropy_bits(24, true) > 140.0);
}

/// The desktop UI sends and receives these exact JSON shapes over Tauri IPC.
#[test]
fn ipc_json_shapes_match_the_interface() {
    let sent = serde_json::json!({
        "type": "login", "title": "Mail", "username": "a", "password": "p",
        "urls": ["https://example.org"], "notes": ""
    });
    let kind: ItemKind = serde_json::from_value(sent).unwrap();
    let note: ItemKind = serde_json::from_value(
        serde_json::json!({"type": "secure_note", "title": "N", "content": "c"}),
    )
    .unwrap();
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    let id = v.add(kind).unwrap();
    v.add(note).unwrap();
    let item = serde_json::to_value(v.get(id).unwrap()).unwrap();
    for key in [
        "id",
        "type",
        "updated_at",
        "title",
        "username",
        "password",
        "urls",
        "notes",
    ] {
        assert!(item.get(key).is_some(), "missing top-level {key}");
    }
    assert_eq!(item["type"], "login");
    let summary = serde_json::to_value(&v.list().unwrap()[0]).unwrap();
    for key in ["id", "type", "title", "subtitle", "updated_at"] {
        assert!(summary.get(key).is_some(), "summary missing {key}");
    }
}

#[test]
fn every_item_type_roundtrips_and_summaries_stay_non_secret() {
    use janus_core::{ApiSecret, Identity, PaymentCard, WifiCredential};
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    let card = v
        .add(ItemKind::PaymentCard(PaymentCard {
            title: "Visa".into(),
            cardholder: "A K".into(),
            number: "4111 1111 1111 1234".into(),
            expiry: "08/29".into(),
            security_code: "987".into(),
            pin: "4321".into(),
            notes: String::new(),
        }))
        .unwrap();
    v.add(ItemKind::Identity(Identity {
        title: "Passport".into(),
        document_type: "passport".into(),
        full_name: "A K".into(),
        document_number: "X1234567".into(),
        issuing_authority: String::new(),
        country: "SK".into(),
        issued_on: String::new(),
        expires_on: "2031-01-01".into(),
        notes: String::new(),
    }))
    .unwrap();
    v.add(ItemKind::Wifi(WifiCredential {
        title: "Home".into(),
        ssid: "Exodus".into(),
        password: "wifi-secret-pass".into(),
        security: "WPA3".into(),
        notes: String::new(),
    }))
    .unwrap();
    v.add(ItemKind::ApiSecret(ApiSecret {
        title: "GitHub token".into(),
        service: "GitHub".into(),
        key_id: "ci".into(),
        secret: "ghp_secretvalue".into(),
        notes: String::new(),
    }))
    .unwrap();
    v.lock();
    v.unlock(PASSWORD).unwrap();
    let summaries = v.list().unwrap();
    let json = serde_json::to_string(&summaries).unwrap();
    for secret in [
        "4111 1111",
        "987",
        "4321",
        "X1234567",
        "wifi-secret-pass",
        "ghp_secretvalue",
    ] {
        assert!(!json.contains(secret), "{secret} in overview");
    }
    let sub = |t: &str| {
        summaries
            .iter()
            .find(|s| s.title == t)
            .unwrap()
            .subtitle
            .clone()
    };
    assert_eq!(sub("Visa"), "•••• 1234");
    assert_eq!(sub("Passport"), "Passport");
    assert_eq!(sub("Home"), "Exodus");
    assert_eq!(sub("GitHub token"), "GitHub");
    match v.get(card).unwrap().kind {
        ItemKind::PaymentCard(c) => {
            assert_eq!((c.security_code.as_str(), c.pin.as_str()), ("987", "4321"))
        }
        _ => panic!("wrong kind"),
    }
    let wifi: ItemKind = serde_json::from_value(serde_json::json!({
        "type": "wifi", "title": "T", "ssid": "S", "password": "p", "security": "WPA2", "notes": ""
    }))
    .unwrap();
    v.add(wifi).unwrap();
}

#[test]
fn login_authenticator_codes_and_validation() {
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    let mut with_key = |key: &str| {
        v.add(ItemKind::Login(Login {
            title: "2FA".into(),
            username: String::new(),
            password: String::new(),
            urls: vec![],
            notes: String::new(),
            totp: key.into(),
        }))
    };
    assert!(matches!(with_key("not a key!"), Err(Error::Invalid(_))));
    let id = with_key("GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ").unwrap();
    let code = v.totp(id).unwrap();
    assert_eq!(code.code.len(), 6);
    assert!(code.code.chars().all(|c| c.is_ascii_digit()));
    assert!((1..=30).contains(&code.remaining));
    let plain = v.add(login("No 2FA", "x")).unwrap();
    assert!(matches!(v.totp(plain), Err(Error::Invalid(_))));
    // Vaults written before the field existed still load.
    let old: ItemKind = serde_json::from_value(serde_json::json!({
        "type": "login", "title": "Old", "username": "", "password": "", "urls": [], "notes": ""
    }))
    .unwrap();
    v.add(old).unwrap();
}

#[test]
fn folders_tags_favorites_and_secret_history() {
    use janus_core::{HISTORY_LIMIT, ItemMeta};
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    let id = v.add(login("Mail", "first-password")).unwrap();
    v.add(login("Bank", "x")).unwrap();
    v.set_meta(
        id,
        ItemMeta {
            folder: "  Work ".into(),
            tags: vec!["email".into(), "Email".into(), " ".into(), "2fa".into()],
            favorite: true,
        },
    )
    .unwrap();
    assert!(matches!(
        v.set_meta(
            id,
            ItemMeta {
                folder: "x".repeat(61),
                ..Default::default()
            }
        ),
        Err(Error::Invalid(_))
    ));
    let summary = v
        .list()
        .unwrap()
        .into_iter()
        .find(|s| s.title == "Mail")
        .unwrap();
    assert_eq!(summary.folder, "Work");
    assert_eq!(summary.tags, ["email", "2fa"]);
    assert!(summary.favorite);
    assert_eq!(v.folders().unwrap(), ["Work"]);

    // Changing the password keeps the old one; metadata survives edits and relocking.
    v.update(id, login("Mail", "second-password")).unwrap();
    v.update(id, login("Mail renamed", "second-password"))
        .unwrap();
    v.lock();
    v.unlock(PASSWORD).unwrap();
    let item = v.get(id).unwrap();
    assert_eq!(item.history.len(), 1);
    assert_eq!(
        (
            item.history[0].field.as_str(),
            item.history[0].value.as_str()
        ),
        ("password", "first-password")
    );
    assert!(item.favorite && item.folder == "Work");
    for n in 0..30 {
        v.update(id, login("Mail", &format!("p{n}"))).unwrap();
    }
    let item = v.get(id).unwrap();
    assert_eq!(item.history.len(), HISTORY_LIMIT);
    assert_eq!(item.history[0].value, "p28");
    // History never reaches the overview.
    let json = serde_json::to_string(&v.list().unwrap()).unwrap();
    assert!(!json.contains("first-password") && !json.contains("p28"));
}

#[test]
fn save_is_all_or_nothing() {
    use janus_core::ItemMeta;
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    let meta = |folder: &str| ItemMeta {
        folder: folder.into(),
        tags: vec!["a".into()],
        favorite: false,
    };
    let id = v.save(None, login("Mail", "one"), meta("Work")).unwrap();
    assert!(matches!(
        v.save(Some(id), login("Mail", "two"), meta(&"x".repeat(61))),
        Err(Error::Invalid(_))
    ));
    let item = v.get(id).unwrap();
    assert!(
        item.history.is_empty(),
        "rejected save must not record history"
    );
    match item.kind {
        ItemKind::Login(l) => assert_eq!(l.password, "one"),
        _ => panic!(),
    }
    v.save(Some(id), login("Mail", "two"), meta("Home"))
        .unwrap();
    assert_eq!(v.get(id).unwrap().folder, "Home");
}
