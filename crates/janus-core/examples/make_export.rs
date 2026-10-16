//! Writes a sample export for checking independent decryptors:
//! cargo run -p janus-core --example make_export -- <path> <export password>
use janus_core::{ItemKind, ItemMeta, KdfParams, Login, MemoryStore, Vault};

fn main() {
    let mut args = std::env::args().skip(1);
    let (path, password) = (
        args.next().expect("path"),
        args.next().expect("export password"),
    );
    let mut vault = Vault::with_params(MemoryStore::default(), KdfParams::insecure_for_tests());
    vault.create("sample master password").unwrap();
    vault
        .save(
            None,
            ItemKind::Login(Login {
                title: "Sample".into(),
                username: "sample-user".into(),
                password: "sample-secret".into(),
                urls: vec!["https://example.org".into()],
                notes: String::new(),
                totp: String::new(),
            }),
            ItemMeta::default(),
        )
        .unwrap();
    std::fs::write(
        path,
        vault.export("sample master password", &password).unwrap(),
    )
    .unwrap();
}
