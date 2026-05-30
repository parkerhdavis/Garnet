// SPDX-License-Identifier: AGPL-3.0-or-later
//! Channel-packing presets for the 3D Texturing plugin. A preset stores only
//! per-channel labels + invert flags (not file paths) — applying one is
//! non-destructive UI context. Built-ins cover the common engine conventions;
//! user presets persist to `<config>/garnet/texturing/presets.json`. Ported
//! from Packi's presets.rs.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::settings::{atomic_write, config_dir};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackingPreset {
	pub name: String,
	pub description: String,
	pub builtin: bool,
	pub labels: ChannelLabels,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelLabels {
	pub r: String,
	pub g: String,
	pub b: String,
	pub a: String,
	#[serde(default)]
	pub r_invert: bool,
	#[serde(default)]
	pub g_invert: bool,
	#[serde(default)]
	pub b_invert: bool,
	#[serde(default)]
	pub a_invert: bool,
}

fn preset(name: &str, description: &str, labels: ChannelLabels) -> PackingPreset {
	PackingPreset {
		name: name.to_string(),
		description: description.to_string(),
		builtin: true,
		labels,
	}
}

fn labels(r: &str, g: &str, b: &str, a: &str, a_invert: bool) -> ChannelLabels {
	ChannelLabels {
		r: r.to_string(),
		g: g.to_string(),
		b: b.to_string(),
		a: a.to_string(),
		r_invert: false,
		g_invert: false,
		b_invert: false,
		a_invert,
	}
}

/// Built-in channel-packing presets for common engine conventions.
#[tauri::command]
pub fn get_builtin_presets() -> Vec<PackingPreset> {
	vec![
		preset(
			"Unreal / Godot \u{2014} ORM",
			"AO, Roughness, Metallic (glTF standard)",
			labels("AO", "Roughness", "Metallic", "", false),
		),
		preset(
			"RMA",
			"Roughness, Metallic, AO",
			labels("Roughness", "Metallic", "AO", "", false),
		),
		preset(
			"Unity HDRP \u{2014} Mask Map (MADS)",
			"Metallic, AO, Detail Mask, Smoothness",
			labels("Metallic", "AO", "Detail Mask", "Smoothness", true),
		),
		preset(
			"Unity URP \u{2014} Metallic + Smoothness",
			"Metallic (grayscale RGB), Smoothness",
			labels("Metallic", "Metallic", "Metallic", "Smoothness", true),
		),
		preset(
			"ORMA",
			"ORM + Alpha for height or opacity",
			labels("AO", "Roughness", "Metallic", "Height / Opacity", false),
		),
		preset(
			"RMAA",
			"RMA + Alpha for height or opacity",
			labels("Roughness", "Metallic", "AO", "Height / Opacity", false),
		),
		preset(
			"Albedo + Alpha",
			"Base color with transparency",
			labels("Base Color R", "Base Color G", "Base Color B", "Opacity", false),
		),
	]
}

fn presets_path() -> Result<PathBuf, String> {
	let dir = config_dir()?.join("texturing");
	std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config directory: {}", e))?;
	Ok(dir.join("presets.json"))
}

#[tauri::command]
pub fn load_user_presets() -> Result<Vec<PackingPreset>, String> {
	let path = presets_path()?;
	if !path.exists() {
		return Ok(Vec::new());
	}
	let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read presets: {}", e))?;
	serde_json::from_str(&content).map_err(|e| format!("Failed to parse presets: {}", e))
}

#[tauri::command]
pub fn save_user_preset(preset: PackingPreset) -> Result<(), String> {
	let mut presets = load_user_presets().unwrap_or_default();
	if let Some(idx) = presets.iter().position(|p| p.name == preset.name) {
		presets[idx] = preset;
	} else {
		presets.push(preset);
	}
	let content = serde_json::to_string_pretty(&presets)
		.map_err(|e| format!("Failed to serialize presets: {}", e))?;
	atomic_write(&presets_path()?, &content)
}

#[tauri::command]
pub fn delete_user_preset(name: String) -> Result<(), String> {
	let mut presets = load_user_presets().unwrap_or_default();
	presets.retain(|p| p.name != name);
	let content = serde_json::to_string_pretty(&presets)
		.map_err(|e| format!("Failed to serialize presets: {}", e))?;
	atomic_write(&presets_path()?, &content)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn builtins_are_well_formed() {
		let presets = get_builtin_presets();
		assert_eq!(presets.len(), 7);
		assert!(presets.iter().all(|p| p.builtin));
		// Mask Map's alpha (Smoothness) inverts; ORM's doesn't.
		let mask = presets.iter().find(|p| p.name.contains("Mask Map")).unwrap();
		assert!(mask.labels.a_invert);
		let orm = presets.iter().find(|p| p.name.contains("ORM")).unwrap();
		assert!(!orm.labels.a_invert);
	}
}
