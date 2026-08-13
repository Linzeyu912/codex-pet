use serde::{
    de::{self, Visitor},
    Deserialize, Deserializer, Serialize,
};
use std::{
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
}
