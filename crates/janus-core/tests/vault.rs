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
            number: "4111 1111 1111 1111".into(),
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
    // Overview text never shows secrets (IDs and timestamps are random, so only the
    // human-readable fields are checked).
    let visible: String = summaries
        .iter()
        .map(|s| format!("{} {}\n", s.title, s.subtitle))
        .collect();
    for secret in [
        "4111 1111",
        "987",
        "4321",
        "X1234567",
        "wifi-secret-pass",
        "ghp_secretvalue",
    ] {
        assert!(!visible.contains(secret), "{secret} in overview");
    }
    let sub = |t: &str| {
        summaries
            .iter()
            .find(|s| s.title == t)
            .unwrap()
            .subtitle
            .clone()
    };
    assert_eq!(sub("Visa"), "•••• 1111");
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
        "type": "wifi", "title": "T", "ssid": "S", "password": "pass-phrase-1", "security": "WPA2", "notes": ""
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
    assert!(matches!(with_key("not a key!"), Err(Error::Fields(_))));
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

#[test]
fn encrypted_export_roundtrip_and_guards() {
    use janus_core::ItemMeta;
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    let id = v
        .save(
            None,
            login("Mail", "exported-secret"),
            ItemMeta {
                folder: "Work".into(),
                tags: vec![],
                favorite: true,
            },
        )
        .unwrap();
    let export_pw = "a separate export passphrase";
    assert!(matches!(
        v.export("wrong master password", export_pw),
        Err(Error::Unlock)
    ));
    assert!(matches!(
        v.export(PASSWORD, "short"),
        Err(Error::WeakPassword)
    ));
    let bytes = v.export(PASSWORD, export_pw).unwrap();
    let text = String::from_utf8(bytes.clone()).unwrap();
    assert!(!text.contains("exported-secret") && !text.contains("Mail") && !text.contains("Work"));

    // Into a different vault: identities, metadata and secrets survive.
    let mut other = vault(MemoryStore::default());
    other.create("another vault password").unwrap();
    assert!(matches!(
        other.preview_export(&bytes, "wrong export password"),
        Err(Error::Unlock)
    ));
    let preview = other.preview_export(&bytes, export_pw).unwrap();
    assert_eq!(preview.len(), 1);
    assert!(other.list().unwrap().is_empty(), "preview must not import");
    let report = other.import_export(&bytes, export_pw).unwrap();
    assert_eq!((report.added, report.skipped_existing), (1, 0));
    let item = other.get(id).unwrap();
    assert!(item.favorite && item.folder == "Work");
    match item.kind {
        ItemKind::Login(l) => assert_eq!(l.password, "exported-secret"),
        _ => panic!(),
    }
    // Importing again changes nothing.
    let again = other.import_export(&bytes, export_pw).unwrap();
    assert_eq!((again.added, again.skipped_existing), (0, 1));

    // Tampering with the header (e.g. weaker parameters) is detected.
    let mut file: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut header: serde_json::Value =
        serde_json::from_slice(&b64.decode(file["header"].as_str().unwrap()).unwrap()).unwrap();
    header["exported_at"] = "2000-01-01T00:00:00Z".into();
    file["header"] = b64.encode(serde_json::to_vec(&header).unwrap()).into();
    let tampered = serde_json::to_vec(&file).unwrap();
    assert!(matches!(
        other.preview_export(&tampered, export_pw),
        Err(Error::Unlock)
    ));
    assert!(matches!(
        other.preview_export(b"{}", export_pw),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn bitwarden_import_maps_types_and_keeps_every_field() {
    use janus_core::ImportFormat;
    let bytes = include_bytes!("fixtures/bitwarden.json");
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    let preview = v
        .preview_import(ImportFormat::BitwardenJson, bytes)
        .unwrap();
    assert_eq!(preview.items.len(), 6);
    assert!(v.list().unwrap().is_empty(), "preview must not import");
    assert_eq!(preview.warnings.len(), 2, "{:?}", preview.warnings); // SSH type + bad 2FA key
    let report = v.import_items(ImportFormat::BitwardenJson, bytes).unwrap();
    assert_eq!(report.added, 6);
    let by_title = |t: &str| {
        let id = v
            .list()
            .unwrap()
            .into_iter()
            .find(|s| s.title == t)
            .unwrap()
            .id;
        v.get(id).unwrap()
    };
    let bank = by_title("Bank");
    assert!(bank.favorite && bank.folder == "Banking");
    assert_eq!(bank.history[0].value, "bank-pass-old");
    match &bank.kind {
        ItemKind::Login(l) => {
            assert_eq!(l.urls.len(), 2);
            assert!(l.notes.contains("main account") && l.notes.contains("Customer ID: C-778"));
            assert!(l.totp.starts_with("otpauth://"));
        }
        _ => panic!(),
    }
    assert!(v.totp(bank.id).is_ok());
    match &by_title("Visa").kind {
        ItemKind::PaymentCard(c) => {
            assert_eq!(
                (c.expiry.as_str(), c.security_code.as_str()),
                ("08/29", "123")
            );
            assert!(c.notes.contains("Brand: Visa"));
        }
        _ => panic!(),
    }
    match &by_title("Me").kind {
        ItemKind::Identity(i) => {
            assert_eq!(
                (i.document_type.as_str(), i.document_number.as_str()),
                ("passport", "PX-998877")
            );
            assert_eq!(i.full_name, "Adrian K");
            assert!(i.notes.contains("email: a@example.org") && !i.notes.contains("PX-998877"));
        }
        _ => panic!(),
    }
    match &by_title("Server key").kind {
        ItemKind::SecureNote(n) => assert!(n.content.contains("ssh-private-x")),
        _ => panic!(),
    }
    match &by_title("Weird 2FA").kind {
        ItemKind::Login(l) => assert!(l.totp.is_empty() && l.notes.contains("not-a-key!!")),
        _ => panic!(),
    }
    let encrypted = br#"{"encrypted": true, "items": []}"#;
    assert!(matches!(
        v.preview_import(ImportFormat::BitwardenJson, encrypted),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn browser_csv_import_handles_chrome_and_firefox() {
    use janus_core::ImportFormat;
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    v.import_items(
        ImportFormat::BrowserCsv,
        include_bytes!("fixtures/chrome.csv"),
    )
    .unwrap();
    let preview = v
        .preview_import(
            ImportFormat::BrowserCsv,
            include_bytes!("fixtures/firefox.csv"),
        )
        .unwrap();
    assert!(preview.kept_in_notes >= 4); // Firefox metadata columns are kept, not dropped
    v.import_items(
        ImportFormat::BrowserCsv,
        include_bytes!("fixtures/firefox.csv"),
    )
    .unwrap();
    let titles: Vec<String> = v.list().unwrap().into_iter().map(|s| s.title).collect();
    assert_eq!(titles, ["example.org", "GitHub", "mail.example"]);
    let gh = v
        .list()
        .unwrap()
        .into_iter()
        .find(|s| s.title == "GitHub")
        .unwrap()
        .id;
    match v.get(gh).unwrap().kind {
        ItemKind::Login(l) => {
            assert_eq!(l.password, "gh,pass \"quoted\"");
            assert_eq!(l.notes, "personal");
        }
        _ => panic!(),
    }
    assert!(matches!(
        v.preview_import(ImportFormat::BrowserCsv, b"a,b\n1,2\n"),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn field_rules_normalize_and_reject_with_per_field_messages() {
    use janus_core::{FieldError, ItemMeta, PaymentCard, WifiCredential};
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    let card = |number: &str, expiry: &str, code: &str, pin: &str| {
        ItemKind::PaymentCard(PaymentCard {
            title: "Card".into(),
            cardholder: String::new(),
            number: number.into(),
            expiry: expiry.into(),
            security_code: code.into(),
            pin: pin.into(),
            notes: String::new(),
        })
    };
    let fields = |result: Result<uuid::Uuid, Error>| match result {
        Err(Error::Fields(errors)) => errors
            .into_iter()
            .map(|e: FieldError| e.field)
            .collect::<Vec<_>>(),
        other => panic!("expected field errors, got {:?}", other.map(|_| ())),
    };
    let meta = ItemMeta::default;
    assert_eq!(
        fields(v.save(
            None,
            card("4111 1111 1111 1111 9999", "13/29", "12345", "12"),
            meta()
        )),
        ["number", "expiry", "security_code", "pin"]
    );
    assert_eq!(
        fields(v.save(None, card("4111 1111 1111 1112", "", "", ""), meta())),
        ["number"]
    );
    assert_eq!(
        fields(v.save(None, card("4111-1111-1111-111a", "", "", ""), meta())),
        ["number"]
    );
    // Separators and long years are normalized.
    let id = v
        .save(
            None,
            card("4111-1111 1111-1111", "8/2029", "987", "4321"),
            meta(),
        )
        .unwrap();
    match v.get(id).unwrap().kind {
        ItemKind::PaymentCard(c) => assert_eq!(
            (c.number.as_str(), c.expiry.as_str()),
            ("4111111111111111", "08/29")
        ),
        _ => panic!(),
    }
    let wifi = |ssid: &str, password: &str, security: &str| {
        ItemKind::Wifi(WifiCredential {
            title: "Net".into(),
            ssid: ssid.into(),
            password: password.into(),
            security: security.into(),
            notes: String::new(),
        })
    };
    assert_eq!(
        fields(v.save(None, wifi("Home", "short", "WPA2"), meta())),
        ["password"]
    );
    assert_eq!(
        fields(v.save(None, wifi(&"x".repeat(33), "long enough", "WPA3"), meta())),
        ["ssid"]
    );
    assert_eq!(
        fields(v.save(None, wifi("Cafe", "secret", "open"), meta())),
        ["password"]
    );
    assert!(
        v.save(None, wifi("Old", "abcde", "WEP"), meta()).is_ok(),
        "5-character WEP keys are valid"
    );
    assert_eq!(fields(v.save(None, login("", "x"), meta())), ["title"]);
}

#[test]
fn imports_keep_rule_breaking_values_in_notes() {
    use janus_core::ImportFormat;
    let mut v = vault(MemoryStore::default());
    v.create(PASSWORD).unwrap();
    let export = br#"{"encrypted": false, "items": [
        {"type": 3, "name": "Old card", "card": {"number": "1234 5678", "code": "12345", "expMonth": "8", "expYear": "2029"}},
        {"type": 1, "name": "", "login": {"username": "u", "password": "p"}}
    ]}"#;
    let preview = v
        .preview_import(ImportFormat::BitwardenJson, export)
        .unwrap();
    assert_eq!(preview.warnings.len(), 2, "{:?}", preview.warnings);
    v.import_items(ImportFormat::BitwardenJson, export).unwrap();
    let titles: Vec<String> = v.list().unwrap().into_iter().map(|s| s.title).collect();
    assert_eq!(titles, ["Imported item", "Old card"]);
    let card = v
        .list()
        .unwrap()
        .into_iter()
        .find(|s| s.title == "Old card")
        .unwrap()
        .id;
    match v.get(card).unwrap().kind {
        ItemKind::PaymentCard(c) => {
            assert!(c.number.is_empty() && c.security_code.is_empty());
            assert_eq!(c.expiry, "08/29");
            assert!(c.notes.contains("12345678") && c.notes.contains("12345"));
        }
        _ => panic!(),
    }
}
