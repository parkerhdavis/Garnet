// SPDX-License-Identifier: AGPL-3.0-or-later
//! Module enumeration stub. Phase 1 only — there is no loader yet, and the
//! module-loading model (dynamic Rust plugin, sidecar process, JS-only) is a
//! deliberate open question. See the Module System doc in the project wiki.
//!
//! `list_modules` reads `<config_dir>/garnet/modules/<id>/manifest.json` from
//! disk and returns whatever it finds. Nothing actually *executes* a module's
//! code yet. The repo's `modules/example-module/manifest.json` is a shape
//! sketch, not a runtime artifact.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ModuleContributions {
	#[serde(default)]
	pub formats: Vec<serde_json::Value>,
	#[serde(default)]
	pub previewers: Vec<serde_json::Value>,
	#[serde(default)]
	pub operations: Vec<serde_json::Value>,
	#[serde(default)]
	pub pipelines: Vec<serde_json::Value>,
	#[serde(default)]
	pub search_facets: Vec<serde_json::Value>,
	#[serde(default)]
	pub settings: Vec<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ModuleManifest {
	pub identity: String,
	pub version: String,
	pub name: String,
	#[serde(default)]
	pub description: String,
	#[serde(default)]
	pub contributions: ModuleContributions,
}

fn modules_dir() -> Option<PathBuf> {
	dirs::config_dir().map(|d| d.join("garnet").join("modules"))
}

#[tauri::command]
pub fn list_modules() -> Result<Vec<ModuleManifest>, String> {
	let Some(dir) = modules_dir() else {
		return Ok(Vec::new());
	};
	if !dir.exists() {
		return Ok(Vec::new());
	}

	let mut out = Vec::new();
	for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
		let entry = match entry {
			Ok(e) => e,
			Err(_) => continue,
		};
		if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
			continue;
		}
		let manifest_path = entry.path().join("manifest.json");
		if !manifest_path.exists() {
			continue;
		}
		match std::fs::read_to_string(&manifest_path)
			.map_err(|e| e.to_string())
			.and_then(|t| serde_json::from_str::<ModuleManifest>(&t).map_err(|e| e.to_string()))
		{
			Ok(m) => out.push(m),
			Err(e) => tracing::warn!("skipping {manifest_path:?}: {e}"),
		}
	}
	Ok(out)
}
