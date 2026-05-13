// SPDX-License-Identifier: AGPL-3.0-or-later
//! Per-user app settings persisted as JSON alongside the library DB. Only the
//! window-size fields are wired up today; future settings (theme, last-opened
//! library, etc.) extend this struct with `Option<T>` fields so older settings
//! files still load.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const APP_DIR_NAME: &str = "garnet";
const SETTINGS_FILE: &str = "settings.json";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AppSettings {
	pub window_width: Option<u32>,
	pub window_height: Option<u32>,
}

fn settings_path() -> Result<PathBuf, String> {
	let base = dirs::config_dir().ok_or_else(|| "no config dir".to_string())?;
	let dir = base.join(APP_DIR_NAME);
	std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
	Ok(dir.join(SETTINGS_FILE))
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
