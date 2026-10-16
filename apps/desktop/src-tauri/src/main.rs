// Janus desktop shell: thin commands over janus-core. DEVELOPMENT BUILD — not reviewed.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use janus_core::{FileStore, Item, ItemKind, ItemMeta, ItemSummary, TotpCode, Vault};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Manager, State};
use uuid::Uuid;

struct AppVault(Mutex<Vault<FileStore>>);

type Reply<T> = Result<T, String>;

fn with<T>(
    state: &State<AppVault>,
    f: impl FnOnce(&mut Vault<FileStore>) -> janus_core::Result<T>,
) -> Reply<T> {
    let mut vault = state
        .0
        .lock()
        .map_err(|_| "Janus is in an inconsistent state; restart it".to_string())?;
    f(&mut vault).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct Status {
    exists: bool,
    unlocked: bool,
}

#[tauri::command]
fn status(state: State<AppVault>) -> Reply<Status> {
    with(&state, |v| {
        Ok(Status {
            exists: v.exists()?,
            unlocked: v.is_unlocked(),
        })
    })
}

// Argon2 takes noticeable time: run off the main thread so the window keeps painting.
#[tauri::command(async)]
fn create(state: State<AppVault>, password: String) -> Reply<()> {
    with(&state, |v| v.create(&password))
}

// Argon2 takes noticeable time: run off the main thread so the window keeps painting.
#[tauri::command(async)]
fn unlock(state: State<AppVault>, password: String) -> Reply<()> {
    with(&state, |v| v.unlock(&password))
}

#[tauri::command]
fn lock(state: State<AppVault>) -> Reply<()> {
    with(&state, |v| {
        v.lock();
        Ok(())
    })
}

#[tauri::command]
fn list(state: State<AppVault>) -> Reply<Vec<ItemSummary>> {
    with(&state, |v| v.list())
}

#[tauri::command]
fn get(state: State<AppVault>, id: Uuid) -> Reply<Item> {
    with(&state, |v| v.get(id))
}

#[tauri::command]
fn save(state: State<AppVault>, id: Option<Uuid>, item: ItemKind, meta: ItemMeta) -> Reply<Uuid> {
    with(&state, |v| v.save(id, item, meta))
}

#[tauri::command]
fn set_meta(state: State<AppVault>, id: Uuid, meta: ItemMeta) -> Reply<()> {
    with(&state, |v| v.set_meta(id, meta))
}

#[tauri::command]
fn totp(state: State<AppVault>, id: Uuid) -> Reply<TotpCode> {
    with(&state, |v| v.totp(id))
}

#[tauri::command]
fn delete(state: State<AppVault>, id: Uuid) -> Reply<()> {
    with(&state, |v| v.delete(id))
}

// Argon2 takes noticeable time: run off the main thread so the window keeps painting.
#[tauri::command(async)]
fn change_password(state: State<AppVault>, current: String, new: String) -> Reply<()> {
    with(&state, |v| v.change_password(&current, &new))
}

#[derive(Serialize)]
struct Generated {
    password: String,
    bits: f64,
}

#[tauri::command]
fn generate(length: usize, symbols: bool) -> Reply<Generated> {
    let password = janus_core::generate_password(length, symbols).map_err(|e| e.to_string())?;
    Ok(Generated {
        password: password.to_string(),
        bits: janus_core::generated_entropy_bits(length, symbols),
    })
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("vault.janus");
            app.manage(AppVault(Mutex::new(Vault::new(FileStore::new(path)))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            create,
            unlock,
            lock,
            list,
            get,
            save,
            delete,
            set_meta,
            totp,
            change_password,
            generate
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Janus");
}
