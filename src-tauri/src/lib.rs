use serde::{
    de::{self, Visitor},
    Deserialize, Deserializer, Serialize,
};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use toml_edit::{value, Array, DocumentMut};

const VALID_STATES: [&str; 13] = [
    "idle",
    "running-right",
    "running-left",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "running",
    "review",
    "looking",
    "rolling",
    "lying",
    "mischief",
];
const MAX_SAFE_UPDATED_AT: u64 = 9_007_199_254_740_991;
const PUBLIC_PET_ID: &str = "codex-aurora-penguin";
const INSTALL_OWNER: &str = "io.github.linzeyu912.codex-pet";
const INSTALL_RECEIPT: &str = ".codex-pet-install-receipt.json";
const PET_MANIFEST_BYTES: &[u8] = include_bytes!("../../public/local/pet.json");
const PET_SPRITESHEET_BYTES: &[u8] = include_bytes!("../../public/local/spritesheet.webp");

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn default_source() -> String {
    "unknown".into()
}

fn normalize_session_id(session_id: Option<String>, fallback: &str) -> String {
    session_id
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

fn deserialize_safe_updated_at<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    struct SafeUpdatedAtVisitor;

    impl<'de> Visitor<'de> for SafeUpdatedAtVisitor {
        type Value = u64;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a positive safe-integer JSON number")
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            is_valid_external_updated_at(value)
                .then_some(value)
                .ok_or_else(|| E::custom("updatedAt is outside the positive safe-integer range"))
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            u64::try_from(value)
                .ok()
                .filter(|value| is_valid_external_updated_at(*value))
                .ok_or_else(|| E::custom("updatedAt is outside the positive safe-integer range"))
        }

        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if value.is_finite()
                && value > 0.0
                && value <= MAX_SAFE_UPDATED_AT as f64
                && value.fract() == 0.0
            {
                Ok(value as u64)
            } else {
                Err(E::custom(
                    "updatedAt is not a finite positive safe-integer number",
                ))
            }
        }
    }

    deserializer.deserialize_any(SafeUpdatedAtVisitor)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetState {
    state: String,
    #[serde(deserialize_with = "deserialize_safe_updated_at")]
    updated_at: u64,
    #[serde(default = "default_source")]
    source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowPosition {
    x: f64,
    y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowMovementBounds {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexIntegrationStatus {
    pet_installed: bool,
    notify_configured: bool,
    notify_conflict: bool,
    codex_home: String,
    config_path: String,
}

#[derive(Deserialize)]
struct CodexNotification {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "thread-id")]
    thread_id: Option<String>,
}

fn logical_movement_bounds(
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
    window_width: u32,
    window_height: u32,
    scale_factor: f64,
) -> WindowMovementBounds {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let min_x = f64::from(work_x) / scale;
    let min_y = f64::from(work_y) / scale;
    WindowMovementBounds {
        min_x,
        min_y,
        max_x: min_x + f64::from(work_width.saturating_sub(window_width)) / scale,
        max_y: min_y + f64::from(work_height.saturating_sub(window_height)) / scale,
    }
}

impl Default for PetState {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            updated_at: 0,
            source: "default".into(),
            expires_at: None,
            session_id: None,
        }
    }
}

fn state_path() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    home.join(".codex-pet").join("state.json")
}

fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join(".codex")
        })
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn is_valid_external_updated_at(updated_at: u64) -> bool {
    (1..=MAX_SAFE_UPDATED_AT).contains(&updated_at)
}

#[cfg(windows)]
fn replace_file_atomically(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{iter, os::windows::ffi::OsStrExt};

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file_atomically(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

fn write_state_atomically(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "state path has no parent"))?;
    fs::create_dir_all(parent)?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state.json");
    let process_id = std::process::id();
    let mut temporary_path = None;
    for _ in 0..16 {
        let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".{file_name}.{process_id}.{}.{counter}.tmp",
            now_millis()
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                if let Err(error) = (|| {
                    file.write_all(contents)?;
                    file.flush()?;
                    file.sync_all()
                })() {
                    drop(file);
                    let _ = fs::remove_file(&candidate);
                    return Err(error);
                }
                temporary_path = Some(candidate);
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    let temporary_path = temporary_path.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "unable to allocate a unique state-file temporary path",
        )
    })?;
    if let Err(error) = replace_file_atomically(&temporary_path, path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    Ok(())
}

fn sha256_hex(contents: &[u8]) -> String {
    format!("{:x}", Sha256::digest(contents))
}

fn path_for_config(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn paths_match(left: &str, right: &Path) -> bool {
    let left = left.replace('\\', "/");
    let right = path_for_config(right);
    if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

fn expected_notify(executable: &Path) -> [String; 2] {
    [path_for_config(executable), "--codex-notify".into()]
}

fn notify_matches(document: &DocumentMut, executable: &Path) -> bool {
    let expected = expected_notify(executable);
    let Some(array) = document.get("notify").and_then(|item| item.as_array()) else {
        return false;
    };
    array.len() == expected.len()
        && array.iter().zip(expected.iter()).all(|(item, expected)| {
            item.as_str()
                .is_some_and(|value| paths_match(value, Path::new(expected)))
        })
}

fn read_config_document(config_path: &Path) -> Result<DocumentMut, String> {
    match fs::read_to_string(config_path) {
        Ok(contents) => contents
            .parse::<DocumentMut>()
            .map_err(|error| format!("无法解析 Codex 配置 {}: {error}", config_path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(DocumentMut::new()),
        Err(error) => Err(format!(
            "无法读取 Codex 配置 {}: {error}",
            config_path.display()
        )),
    }
}

fn reject_link(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let mut is_link = metadata.file_type().is_symlink();
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
                is_link |= metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
            }
            if is_link {
                Err(format!("{label}不能是链接或 junction：{}", path.display()))
            } else {
                Ok(())
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法检查{label} {}: {error}", path.display())),
    }
}

fn configure_notify(config_path: &Path, executable: &Path) -> Result<(bool, bool), String> {
    reject_link(config_path, "Codex 配置文件")?;
    let mut document = read_config_document(config_path)?;
    if notify_matches(&document, executable) {
        return Ok((true, false));
    }
    if document.get("notify").is_some() {
        return Ok((false, true));
    }

    let mut command = Array::new();
    for argument in expected_notify(executable) {
        command.push(argument);
    }
    document["notify"] = value(command);
    write_state_atomically(config_path, document.to_string().as_bytes())
        .map_err(|error| format!("无法更新 Codex 配置 {}: {error}", config_path.display()))?;
    Ok((true, false))
}

fn integration_paths() -> (PathBuf, PathBuf, PathBuf) {
    let home = codex_home();
    let destination = home.join("pets").join(PUBLIC_PET_ID);
    let config = home.join("config.toml");
    (home, destination, config)
}

fn file_matches(path: &Path, expected: &[u8]) -> bool {
    fs::read(path)
        .map(|contents| contents == expected)
        .unwrap_or(false)
}

fn public_pet_is_current(destination: &Path) -> bool {
    file_matches(&destination.join("pet.json"), PET_MANIFEST_BYTES)
        && file_matches(&destination.join("spritesheet.webp"), PET_SPRITESHEET_BYTES)
}

fn owned_install_is_unmodified(destination: &Path) -> bool {
    let Ok(receipt_text) = fs::read_to_string(destination.join(INSTALL_RECEIPT)) else {
        return false;
    };
    let Ok(receipt) = serde_json::from_str::<serde_json::Value>(&receipt_text) else {
        return false;
    };
    if receipt.get("owner").and_then(serde_json::Value::as_str) != Some(INSTALL_OWNER)
        || receipt
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(1)
        || receipt.get("petId").and_then(serde_json::Value::as_str) != Some(PUBLIC_PET_ID)
        || !receipt
            .get("destination")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| paths_match(value, destination))
    {
        return false;
    }
    let Some(files) = receipt.get("files").and_then(serde_json::Value::as_array) else {
        return false;
    };
    if files.len() != 2 {
        return false;
    }
    let mut saw_manifest = false;
    let mut saw_spritesheet = false;
    for entry in files {
        let Some(relative) = entry.get("path").and_then(serde_json::Value::as_str) else {
            return false;
        };
        let already_seen = match relative {
            "pet.json" => std::mem::replace(&mut saw_manifest, true),
            "spritesheet.webp" => std::mem::replace(&mut saw_spritesheet, true),
            _ => return false,
        };
        if already_seen {
            return false;
        }
        let Ok(contents) = fs::read(destination.join(relative)) else {
            return false;
        };
        let matches = entry.get("bytes").and_then(serde_json::Value::as_u64)
            == Some(contents.len() as u64)
            && entry.get("sha256").and_then(serde_json::Value::as_str)
                == Some(sha256_hex(&contents).as_str());
        if !matches {
            return false;
        }
    }
    saw_manifest && saw_spritesheet
}

fn unique_sibling(parent: &Path, label: &str) -> PathBuf {
    parent.join(format!(
        ".{PUBLIC_PET_ID}-{label}-{}-{}",
        now_millis(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

fn install_public_pet(destination: &Path) -> Result<(), String> {
    reject_link(destination, "Codex 宠物目录")?;
    if public_pet_is_current(destination) {
        return Ok(());
    }
    if destination.exists() && !owned_install_is_unmodified(destination) {
        return Err(format!(
            "检测到未由 Codex Pet 管理或已被修改的目录，未覆盖：{}",
            destination.display()
        ));
    }

    let pets_root = destination
        .parent()
        .ok_or_else(|| "Codex 宠物目录无效".to_owned())?;
    reject_link(pets_root, "Codex pets 目录")?;
    fs::create_dir_all(pets_root)
        .map_err(|error| format!("无法创建 Codex 宠物目录 {}: {error}", pets_root.display()))?;
    let staging = unique_sibling(pets_root, "install");
    fs::create_dir(&staging)
        .map_err(|error| format!("无法创建安装暂存目录 {}: {error}", staging.display()))?;

    let backup = destination.exists().then(|| {
        pets_root
            .join(".codex-pet-backups")
            .join(PUBLIC_PET_ID)
            .join(now_millis().to_string())
    });
    let install_result = (|| -> Result<(), String> {
        fs::write(staging.join("pet.json"), PET_MANIFEST_BYTES)
            .map_err(|error| format!("无法暂存 pet.json: {error}"))?;
        fs::write(staging.join("spritesheet.webp"), PET_SPRITESHEET_BYTES)
            .map_err(|error| format!("无法暂存 spritesheet.webp: {error}"))?;
        let files = [
            ("pet.json", PET_MANIFEST_BYTES),
            ("spritesheet.webp", PET_SPRITESHEET_BYTES),
        ]
        .map(|(path, contents)| {
            serde_json::json!({
                "path": path,
                "bytes": contents.len(),
                "sha256": sha256_hex(contents),
            })
        });
        let receipt = serde_json::json!({
            "schemaVersion": 1,
            "owner": INSTALL_OWNER,
            "packageVersion": env!("CARGO_PKG_VERSION"),
            "petId": PUBLIC_PET_ID,
            "installedAt": now_millis(),
            "destination": path_for_config(destination),
            "backupPath": backup.as_ref().map(|path| path_for_config(path)),
            "files": files,
        });
        fs::write(
            staging.join(INSTALL_RECEIPT),
            serde_json::to_vec_pretty(&receipt).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("无法写入安装凭据: {error}"))?;

        if let Some(backup_path) = &backup {
            let backup_root = pets_root.join(".codex-pet-backups");
            let pet_backup_root = backup_root.join(PUBLIC_PET_ID);
            reject_link(&backup_root, "Codex Pet 备份根目录")?;
            reject_link(&pet_backup_root, "当前宠物备份目录")?;
            let parent = backup_path
                .parent()
                .ok_or_else(|| "备份目录无效".to_owned())?;
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建备份目录 {}: {error}", parent.display()))?;
            fs::rename(destination, backup_path)
                .map_err(|error| format!("无法备份旧版宠物: {error}"))?;
        }
        if let Err(error) = fs::rename(&staging, destination) {
            if let Some(backup_path) = &backup {
                if let Err(rollback_error) = fs::rename(backup_path, destination) {
                    return Err(format!(
                        "无法启用新版宠物：{error}；旧版恢复也失败：{rollback_error}。旧版仍保留在 {}",
                        backup_path.display()
                    ));
                }
            }
            return Err(format!("无法启用新版宠物: {error}"));
        }
        Ok(())
    })();
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    install_result
}

fn integration_status_for(executable: &Path) -> Result<CodexIntegrationStatus, String> {
    let (home, destination, config_path) = integration_paths();
    let document = read_config_document(&config_path)?;
    let notify_configured = notify_matches(&document, executable);
    Ok(CodexIntegrationStatus {
        pet_installed: public_pet_is_current(&destination),
        notify_configured,
        notify_conflict: !notify_configured && document.get("notify").is_some(),
        codex_home: home.to_string_lossy().into_owned(),
        config_path: config_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn get_codex_integration_status() -> Result<CodexIntegrationStatus, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    integration_status_for(&executable)
}

#[tauri::command]
fn install_codex_integration() -> Result<CodexIntegrationStatus, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let (_, destination, config_path) = integration_paths();
    install_public_pet(&destination)?;
    let _ = configure_notify(&config_path, &executable)?;
    integration_status_for(&executable)
}

fn write_notify_payload(path: &Path, payload: &str, updated_at: u64) -> Result<(), String> {
    let notification: CodexNotification = serde_json::from_str(payload)
        .map_err(|error| format!("Invalid Codex notification: {error}"))?;
    if notification.kind != "agent-turn-complete" {
        return Ok(());
    }
    let state = PetState {
        state: "jumping".into(),
        updated_at,
        source: "codex-notify".into(),
        expires_at: Some(serde_json::Value::from(updated_at + 8_000)),
        session_id: Some(serde_json::Value::String(normalize_session_id(
            notification.thread_id,
            "codex-notify",
        ))),
    };
    let bytes = serde_json::to_vec_pretty(&state).map_err(|error| error.to_string())?;
    write_state_atomically(path, &bytes).map_err(|error| error.to_string())
}

pub fn handle_notify_arguments<I>(arguments: I) -> bool
where
    I: IntoIterator<Item = OsString>,
{
    let mut arguments = arguments.into_iter();
    let _ = arguments.next();
    while let Some(argument) = arguments.next() {
        if argument == "--codex-notify" {
            if let Some(payload) = arguments.next() {
                let _ =
                    write_notify_payload(&state_path(), &payload.to_string_lossy(), now_millis());
            }
            return true;
        }
    }
    false
}

#[tauri::command]
fn read_pet_state() -> PetState {
    fs::read_to_string(state_path())
        .ok()
        .and_then(|content| serde_json::from_str::<PetState>(&content).ok())
        .filter(|state| {
            VALID_STATES.contains(&state.state.as_str())
                && is_valid_external_updated_at(state.updated_at)
        })
        .unwrap_or_default()
}

#[tauri::command]
fn set_pet_state(
    state: String,
    source: Option<String>,
    expires_at: Option<u64>,
    session_id: Option<String>,
) -> Result<PetState, String> {
    if !VALID_STATES.contains(&state.as_str()) {
        return Err(format!("Unsupported pet state: {state}"));
    }

    let updated_at = now_millis();
    let is_idle = state == "idle";
    let payload = PetState {
        state,
        updated_at,
        source: source.unwrap_or_else(|| "desktop".into()),
        expires_at: if expires_at.is_some() || is_idle {
            expires_at.map(serde_json::Value::from)
        } else {
            Some(serde_json::Value::from(updated_at + 15 * 60 * 1000))
        },
        session_id: Some(serde_json::Value::String(normalize_session_id(
            session_id,
            "tauri-desktop",
        ))),
    };
    let path = state_path();
    let json = serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    write_state_atomically(&path, json.as_bytes()).map_err(|error| error.to_string())?;
    Ok(payload)
}

#[tauri::command]
fn get_pet_window_position(window: tauri::WebviewWindow) -> Result<WindowPosition, String> {
    let physical = window.outer_position().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    Ok(WindowPosition {
        x: f64::from(physical.x) / scale,
        y: f64::from(physical.y) / scale,
    })
}

#[tauri::command]
fn get_pet_movement_bounds(window: tauri::WebviewWindow) -> Result<WindowMovementBounds, String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "The pet window is not attached to a monitor.".to_owned())?;
    let work_area = monitor.work_area();
    let window_size = window.outer_size().map_err(|error| error.to_string())?;
    Ok(logical_movement_bounds(
        work_area.position.x,
        work_area.position.y,
        work_area.size.width,
        work_area.size.height,
        window_size.width,
        window_size.height,
        monitor.scale_factor(),
    ))
}

#[tauri::command]
fn move_pet_window(window: tauri::WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    window
        .set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_pet(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            read_pet_state,
            set_pet_state,
            get_pet_window_position,
            get_pet_movement_bounds,
            get_codex_integration_status,
            install_codex_integration,
            move_pet_window,
            hide_pet,
            quit_app
        ])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "显示宠物", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "隐藏宠物", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

            let mut tray = TrayIconBuilder::new()
                .tooltip("Codex Pet")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Codex Pet");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "codex-pet-{label}-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn state_contract_accepts_optional_source_and_text_expiration() {
        let state: PetState = serde_json::from_str(
            r#"{"state":"running","updatedAt":42,"expiresAt":"2026-07-16T12:00:00+08:00"}"#,
        )
        .expect("contract-compatible state should deserialize");

        assert_eq!(state.source, "unknown");
        assert_eq!(
            state
                .expires_at
                .as_ref()
                .and_then(serde_json::Value::as_str),
            Some("2026-07-16T12:00:00+08:00")
        );
    }

    #[test]
    fn optional_external_fields_survive_for_frontend_normalization() {
        for expires_at in ["-1", "0.5", r#"{"unexpected":true}"#, "[1,2]"] {
            let state: PetState = serde_json::from_str(&format!(
                r#"{{"state":"running","updatedAt":42,"expiresAt":{expires_at},"sessionId":123}}"#
            ))
            .expect("optional external fields should remain available to the frontend");
            let expected_expiration: serde_json::Value =
                serde_json::from_str(expires_at).expect("fixture expiration should be valid JSON");

            assert_eq!(state.state, "running");
            assert_eq!(state.updated_at, 42);
            assert_eq!(state.expires_at.as_ref(), Some(&expected_expiration));
            assert_eq!(
                state
                    .session_id
                    .as_ref()
                    .and_then(serde_json::Value::as_i64),
                Some(123)
            );
        }
    }

    #[test]
    fn session_ids_are_trimmed_or_replaced_with_a_safe_writer_default() {
        assert_eq!(
            normalize_session_id(Some("  task-1  ".into()), "tauri-desktop"),
            "task-1"
        );
        assert_eq!(
            normalize_session_id(Some("   ".into()), "tauri-desktop"),
            "tauri-desktop"
        );
        assert_eq!(normalize_session_id(None, "tauri-desktop"), "tauri-desktop");
    }

    #[test]
    fn external_updated_at_requires_a_positive_safe_integer() {
        assert!(is_valid_external_updated_at(1));
        assert!(is_valid_external_updated_at(MAX_SAFE_UPDATED_AT));
        assert!(!is_valid_external_updated_at(0));
        assert!(!is_valid_external_updated_at(MAX_SAFE_UPDATED_AT + 1));

        for invalid in [
            r#"{"state":"running","updatedAt":0}"#,
            r#"{"state":"running","updatedAt":-1}"#,
            r#"{"state":"running","updatedAt":true}"#,
            r#"{"state":"running","updatedAt":"1"}"#,
            r#"{"state":"running","updatedAt":1.5}"#,
            r#"{"state":"running","updatedAt":null}"#,
            r#"{"state":"running","updatedAt":NaN}"#,
            r#"{"state":"running","updatedAt":Infinity}"#,
            r#"{"state":"running","updatedAt":9007199254740992}"#,
        ] {
            assert!(
                serde_json::from_str::<PetState>(invalid).is_err(),
                "invalid updatedAt should fail deserialization: {invalid}"
            );
        }

        for valid in ["1", "1.0", "1e3", "9007199254740991"] {
            let state: PetState =
                serde_json::from_str(&format!(r#"{{"state":"running","updatedAt":{valid}}}"#))
                    .expect("an integer-valued safe JSON number should deserialize");
            assert!(is_valid_external_updated_at(state.updated_at));
        }
    }

    #[test]
    fn atomic_state_write_replaces_existing_file() {
        let directory = std::env::temp_dir().join(format!(
            "codex-pet-state-test-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let path = directory.join("state.json");
        fs::create_dir_all(&directory).expect("test directory should be created");
        fs::write(&path, b"old").expect("fixture should be written");

        write_state_atomically(&path, b"new").expect("state should be replaced atomically");

        assert_eq!(fs::read(&path).expect("state should be readable"), b"new");
        fs::remove_dir_all(directory).expect("test directory should be removed");
    }

    #[test]
    fn movement_bounds_use_monitor_work_area_and_support_negative_origins() {
        assert_eq!(
            logical_movement_bounds(-1920, 0, 1920, 1040, 260, 286, 1.0),
            WindowMovementBounds {
                min_x: -1920.0,
                min_y: 0.0,
                max_x: -260.0,
                max_y: 754.0,
            }
        );
        assert_eq!(
            logical_movement_bounds(0, -2160, 3840, 2080, 520, 572, 2.0),
            WindowMovementBounds {
                min_x: 0.0,
                min_y: -1080.0,
                max_x: 1660.0,
                max_y: -326.0,
            }
        );
    }

    #[test]
    fn codex_notify_writes_a_short_lived_completion_state() {
        let directory = unique_test_directory("notify");
        let path = directory.join("state.json");
        write_notify_payload(
            &path,
            r#"{"type":"agent-turn-complete","thread-id":"thread-7"}"#,
            1_000,
        )
        .expect("notification should be written");

        let state: PetState = serde_json::from_slice(&fs::read(&path).expect("state should exist"))
            .expect("state should be valid JSON");
        assert_eq!(state.state, "jumping");
        assert_eq!(state.updated_at, 1_000);
        assert_eq!(state.source, "codex-notify");
        assert_eq!(state.expires_at, Some(serde_json::Value::from(9_000)));
        assert_eq!(
            state.session_id,
            Some(serde_json::Value::String("thread-7".into()))
        );
        fs::remove_dir_all(directory).expect("test directory should be removed");
    }

    #[test]
    fn notify_configuration_is_idempotent_and_preserves_conflicts() {
        let directory = unique_test_directory("notify-config");
        fs::create_dir_all(&directory).expect("test directory should exist");
        let config = directory.join("config.toml");
        let executable = directory.join("Codex Pet.exe");

        assert_eq!(
            configure_notify(&config, &executable).expect("notify should be configured"),
            (true, false)
        );
        let first = fs::read_to_string(&config).expect("config should exist");
        assert!(first.contains("--codex-notify"));
        assert_eq!(
            configure_notify(&config, &executable).expect("configuration should be idempotent"),
            (true, false)
        );
        assert_eq!(
            fs::read_to_string(&config).expect("config should still exist"),
            first
        );

        fs::write(&config, "model = \"gpt-test\"\nnotify = [\"other.exe\"]\n")
            .expect("conflict fixture should be written");
        assert_eq!(
            configure_notify(&config, &executable).expect("conflict should be reported"),
            (false, true)
        );
        assert_eq!(
            fs::read_to_string(&config).expect("conflicting config should remain readable"),
            "model = \"gpt-test\"\nnotify = [\"other.exe\"]\n"
        );
        fs::remove_dir_all(directory).expect("test directory should be removed");
    }

    #[test]
    fn native_pet_install_is_atomic_owned_and_tamper_aware() {
        let directory = unique_test_directory("native-install");
        let destination = directory.join("pets").join(PUBLIC_PET_ID);
        install_public_pet(&destination).expect("fresh install should succeed");
        assert!(public_pet_is_current(&destination));
        assert!(owned_install_is_unmodified(&destination));

        let receipt_path = destination.join(INSTALL_RECEIPT);
        let original_receipt = fs::read(&receipt_path).expect("receipt should be readable");
        let mut duplicate_receipt: serde_json::Value =
            serde_json::from_slice(&original_receipt).expect("receipt should be valid JSON");
        let duplicate_files = duplicate_receipt["files"]
            .as_array_mut()
            .expect("receipt files should be an array");
        duplicate_files[1] = duplicate_files[0].clone();
        fs::write(
            &receipt_path,
            serde_json::to_vec_pretty(&duplicate_receipt).expect("fixture should serialize"),
        )
        .expect("duplicate receipt should be written");
        assert!(!owned_install_is_unmodified(&destination));
        fs::write(&receipt_path, original_receipt).expect("original receipt should be restored");

        fs::write(destination.join("pet.json"), b"modified")
            .expect("fixture should modify installed content");
        let error =
            install_public_pet(&destination).expect_err("modified install must be preserved");
        assert!(error.contains("未覆盖"));
        assert_eq!(
            fs::read(destination.join("pet.json")).expect("modified file should remain"),
            b"modified"
        );
        fs::remove_dir_all(directory).expect("test directory should be removed");
    }
}
