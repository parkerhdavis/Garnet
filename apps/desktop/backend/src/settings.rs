// SPDX-License-Identifier: AGPL-3.0-or-later
//! Per-user app settings persisted as JSON alongside the library DB. Only the
//! window-size fields are wired up today; future settings (theme, last-opened
//! library, etc.) extend this struct with `Option<T>` fields so older settings
//! files still load.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

const APP_DIR_NAME: &str = "garnet";
const SETTINGS_FILE: &str = "settings.json";

/// Garnet's config directory (`<config>/garnet`), created if missing. Shared
/// home for settings.json and the JSON preset files plugins/modules persist
/// (automations.json, texturing/presets.json, …).
pub fn config_dir() -> Result<PathBuf, String> {
	let base = dirs::config_dir().ok_or_else(|| "no config dir".to_string())?;
	let dir = base.join(APP_DIR_NAME);
	std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
	Ok(dir)
}

/// Write `content` to `path` atomically: write a sibling `.tmp`, fsync, then
/// rename over the target so a crash mid-write can't leave a truncated file.
pub fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
	let tmp_path = path.with_extension("tmp");
	let mut file = std::fs::File::create(&tmp_path)
		.map_err(|e| format!("Failed to create temp file: {}", e))?;
	file.write_all(content.as_bytes())
		.map_err(|e| format!("Failed to write temp file: {}", e))?;
	file.sync_all()
		.map_err(|e| format!("Failed to sync temp file: {}", e))?;
	std::fs::rename(&tmp_path, path).map_err(|e| format!("Failed to rename temp file: {}", e))?;
	Ok(())
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AppSettings {
	pub window_width: Option<u32>,
	pub window_height: Option<u32>,
	/// Ids of plugins the user has enabled. `None` means "never configured" —
	/// the frontend applies its own default (see `pluginsStore`). The built-in
	/// `core` pseudo-plugin is always on and is never listed here. Persisted so
	/// enable/disable survives restarts; kept in settings rather than the
	/// library DB because it's tiny app-global state, not per-library data.
	#[serde(default)]
	pub enabled_plugins: Option<Vec<String>>,
}

fn settings_path() -> Result<PathBuf, String> {
	Ok(config_dir()?.join(SETTINGS_FILE))
}

#[tauri::command]
pub fn load_settings() -> Result<AppSettings, String> {
	let path = settings_path()?;
	if !path.exists() {
		return Ok(AppSettings::default());
	}
	let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
	serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_settings(settings: AppSettings) -> Result<(), String> {
	let path = settings_path()?;
	let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
	std::fs::write(&path, text).map_err(|e| e.to_string())?;
	Ok(())
}
