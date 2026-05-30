// SPDX-License-Identifier: AGPL-3.0-or-later
//! The Automations module: a pipeline of steps applied in bulk to image files,
//! always writing to a separate output directory (non-destructive). Ported
//! from Packi's batch processor.
//!
//! Base steps (Convert / Resize / Rename) live here. Plugins contribute
//! additional step *variants* and their implementations: the 3D Texturing
//! plugin adds FlipGreen / Normalize, whose pixel ops delegate to
//! `crate::texturing::normal_map` from the executor's match (added when that
//! module lands). The `AutomationStep` enum is a single compile-time enum —
//! fine for a first-party, compiled-in plugin model; a dynamic step registry
//! would only be needed for out-of-scope third-party plugins.

use image::imageops::FilterType;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tauri::Emitter;

use crate::image_io::{load_dynamic_image, save_image};
use crate::settings::{atomic_write, config_dir};

/// One pipeline step. Tagged enum so the frontend builds `{ type, ...params }`
/// payloads directly. The 3D Texturing plugin appends FlipGreen / Normalize.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AutomationStep {
	#[serde(rename = "convert")]
	Convert { format: String, bit_depth: u8 },
	#[serde(rename = "resize")]
	Resize {
		mode: String,
		width: u32,
		height: u32,
		filter: String,
	},
	#[serde(rename = "rename")]
	Rename { pattern: String },
	// Contributed by the 3D Texturing plugin; implemented via
	// `crate::texturing::normal_map` in the executor.
	#[serde(rename = "flip-green")]
	FlipGreen,
	#[serde(rename = "normalize")]
	Normalize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationPipeline {
	pub steps: Vec<AutomationStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationPreviewItem {
	pub input_path: String,
	pub output_filename: String,
	pub output_format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationResult {
	pub processed: usize,
	pub failed: Vec<AutomationFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationFailure {
	pub path: String,
	pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedPipeline {
	pub name: String,
	pub steps: Vec<AutomationStep>,
}

/// Preview what the pipeline would produce (output names/formats) without
/// running it. Only name- and format-affecting steps matter here.
#[tauri::command]
pub fn preview_automation(
	files: Vec<String>,
	pipeline: AutomationPipeline,
) -> Result<Vec<AutomationPreviewItem>, String> {
	let mut items = Vec::new();

	for (idx, file_path) in files.iter().enumerate() {
		let path = Path::new(file_path);
		let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
		let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("png");

		let mut output_name = stem.to_string();
		let mut output_format = ext.to_string();

		for step in &pipeline.steps {
			match step {
				AutomationStep::Convert { format, .. } => {
					output_format = format_to_extension(format);
				}
				AutomationStep::Rename { pattern } => {
					output_name = apply_rename_pattern(pattern, stem, &output_format, idx);
				}
				// Pixel-only steps don't change the filename or format.
				AutomationStep::Resize { .. }
				| AutomationStep::FlipGreen
				| AutomationStep::Normalize => {}
			}
		}

		items.push(AutomationPreviewItem {
			input_path: file_path.clone(),
			output_filename: format!("{}.{}", output_name, output_format),
			output_format: output_format.to_uppercase(),
		});
	}

	Ok(items)
}

/// Run the pipeline over all files in parallel, emitting `automation:progress`
/// events `{ current, total, current_file }`.
#[tauri::command]
pub async fn run_automation(
	files: Vec<String>,
	pipeline: AutomationPipeline,
	output_dir: String,
	continue_on_error: Option<bool>,
	app_handle: tauri::AppHandle,
) -> Result<AutomationResult, String> {
	let bail_on_error = !continue_on_error.unwrap_or(true);
	tokio::task::spawn_blocking(move || {
		run_automation_sync(files, pipeline, output_dir, bail_on_error, app_handle)
	})
	.await
	.map_err(|e| format!("Task failed: {}", e))?
}

fn run_automation_sync(
	files: Vec<String>,
	pipeline: AutomationPipeline,
	output_dir: String,
	bail_on_error: bool,
	app_handle: tauri::AppHandle,
) -> Result<AutomationResult, String> {
	fs::create_dir_all(&output_dir)
		.map_err(|e| format!("Failed to create output directory: {}", e))?;

	let total = files.len();
	let completed = AtomicUsize::new(0);
	let aborted = AtomicBool::new(false);

	let results: Vec<Result<(), AutomationFailure>> = files
		.par_iter()
		.enumerate()
		.map(|(idx, file_path)| {
			if bail_on_error && aborted.load(Ordering::Relaxed) {
				return Err(AutomationFailure {
					path: file_path.clone(),
					error: "Skipped (previous error)".to_string(),
				});
			}
			let result = process_single_file(file_path, &pipeline, &output_dir, idx);
			if result.is_err() && bail_on_error {
				aborted.store(true, Ordering::Relaxed);
			}
			let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
			let _ = app_handle.emit(
				"automation:progress",
				serde_json::json!({ "current": done, "total": total, "current_file": file_path }),
			);
			result.map_err(|e| AutomationFailure {
				path: file_path.clone(),
				error: e,
			})
		})
		.collect();

	let mut processed = 0usize;
	let mut failed = Vec::new();
	for r in results {
		match r {
			Ok(()) => processed += 1,
			Err(f) => failed.push(f),
		}
	}

	let _ = app_handle.emit(
		"automation:progress",
		serde_json::json!({ "current": total, "total": total, "current_file": "" }),
	);

	Ok(AutomationResult { processed, failed })
}

fn process_single_file(
	file_path: &str,
	pipeline: &AutomationPipeline,
	output_dir: &str,
	idx: usize,
) -> Result<(), String> {
	let path = Path::new(file_path);
	let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
	let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("png");

	let mut img = load_dynamic_image(file_path)?;
	let mut output_name = stem.to_string();
	let mut output_ext = ext.to_string();
	let mut save_format = ext.to_string();

	for step in &pipeline.steps {
		match step {
			AutomationStep::Convert { format, .. } => {
				output_ext = format_to_extension(format);
				save_format = format.clone();
			}
			AutomationStep::Resize {
				mode,
				width,
				height,
				filter,
			} => {
				let filter_type = match filter.as_str() {
					"lanczos" => FilterType::Lanczos3,
					"bilinear" => FilterType::Triangle,
					"nearest" => FilterType::Nearest,
					_ => FilterType::Lanczos3,
				};
				let (cur_w, cur_h) = image::GenericImageView::dimensions(&img);
				let (new_w, new_h) = match mode.as_str() {
					"exact" => (*width, *height),
					"scale" => {
						let scale = *width as f32 / 100.0;
						(
							(cur_w as f32 * scale).round() as u32,
							(cur_h as f32 * scale).round() as u32,
						)
					}
					"nearest-pot" => (nearest_pot(cur_w), nearest_pot(cur_h)),
					_ => (*width, *height),
				};
				if new_w > 0 && new_h > 0 {
					img = img.resize_exact(new_w, new_h, filter_type);
				}
			}
			AutomationStep::Rename { pattern } => {
				output_name = apply_rename_pattern(pattern, stem, &output_ext, idx);
			}
			AutomationStep::FlipGreen => {
				img = image::DynamicImage::ImageRgba8(
					crate::texturing::normal_map::flip_green_on_image(img.to_rgba8()),
				);
			}
			AutomationStep::Normalize => {
				img = image::DynamicImage::ImageRgba8(
					crate::texturing::normal_map::normalize_on_image(img.to_rgba8()),
				);
			}
		}
	}

	let output_path = Path::new(output_dir).join(format!("{}.{}", output_name, output_ext));
	let output_str = output_path
		.to_str()
		.ok_or_else(|| format!("Output path contains invalid UTF-8: {:?}", output_path))?;
	save_image(&img, output_str, &save_format)
}

fn format_to_extension(format: &str) -> String {
	match format {
		"png8" | "png16" => "png".to_string(),
		"jpeg" => "jpg".to_string(),
		other => other.to_string(),
	}
}

fn apply_rename_pattern(pattern: &str, name: &str, ext: &str, index: usize) -> String {
	pattern
		.replace("{name}", name)
		.replace("{ext}", ext)
		.replace("{index}", &format!("{:04}", index))
}

fn nearest_pot(v: u32) -> u32 {
	if v == 0 {
		return 1;
	}
	let lower = 1u32 << (31 - v.leading_zeros());
	let upper = lower << 1;
	if v - lower < upper - v {
		lower
	} else {
		upper
	}
}

fn presets_path() -> Result<PathBuf, String> {
	Ok(config_dir()?.join("automations.json"))
}

#[tauri::command]
pub fn save_automation_preset(name: String, steps: Vec<AutomationStep>) -> Result<(), String> {
	let mut presets = load_automation_presets().unwrap_or_default();
	if let Some(idx) = presets.iter().position(|p| p.name == name) {
		presets[idx].steps = steps;
	} else {
		presets.push(NamedPipeline { name, steps });
	}
	let content = serde_json::to_string_pretty(&presets)
		.map_err(|e| format!("Failed to serialize automation presets: {}", e))?;
	atomic_write(&presets_path()?, &content)
}

#[tauri::command]
pub fn load_automation_presets() -> Result<Vec<NamedPipeline>, String> {
	let path = presets_path()?;
	if !path.exists() {
		return Ok(Vec::new());
	}
	let content =
		fs::read_to_string(&path).map_err(|e| format!("Failed to read automation presets: {}", e))?;
	serde_json::from_str(&content)
		.map_err(|e| format!("Failed to parse automation presets: {}", e))
}

#[tauri::command]
pub fn delete_automation_preset(name: String) -> Result<(), String> {
	let mut presets = load_automation_presets().unwrap_or_default();
	presets.retain(|p| p.name != name);
	let content = serde_json::to_string_pretty(&presets)
		.map_err(|e| format!("Failed to serialize automation presets: {}", e))?;
	atomic_write(&presets_path()?, &content)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn format_to_extension_maps() {
		assert_eq!(format_to_extension("png8"), "png");
		assert_eq!(format_to_extension("png16"), "png");
		assert_eq!(format_to_extension("jpeg"), "jpg");
		assert_eq!(format_to_extension("tga"), "tga");
		assert_eq!(format_to_extension("exr"), "exr");
	}

	#[test]
	fn rename_pattern_substitutions() {
		assert_eq!(apply_rename_pattern("{name}_out", "rock", "png", 0), "rock_out");
		assert_eq!(apply_rename_pattern("{name}.{ext}", "rock", "tga", 0), "rock.tga");
		assert_eq!(apply_rename_pattern("f_{index}", "rock", "png", 5), "f_0005");
		assert_eq!(
			apply_rename_pattern("{name}_{index}.{ext}", "rock", "jpg", 42),
			"rock_0042.jpg"
		);
	}

	#[test]
	fn nearest_pot_rounding() {
		assert_eq!(nearest_pot(0), 1);
		assert_eq!(nearest_pot(256), 256);
		assert_eq!(nearest_pot(300), 256); // closer to 256
		assert_eq!(nearest_pot(400), 512); // closer to 512
		assert_eq!(nearest_pot(384), 512); // midpoint rounds up
	}

	#[test]
	fn preview_convert_then_rename() {
		let files = vec!["/p/texture.png".to_string()];
		let pipeline = AutomationPipeline {
			steps: vec![
				AutomationStep::Convert { format: "jpeg".to_string(), bit_depth: 8 },
				AutomationStep::Rename { pattern: "{name}_out".to_string() },
			],
		};
		let out = preview_automation(files, pipeline).unwrap();
		assert_eq!(out[0].output_filename, "texture_out.jpg");
		assert_eq!(out[0].output_format, "JPG");
	}

	#[test]
	fn preview_multiple_files_index() {
		let files = vec!["/a/one.png".to_string(), "/b/two.tga".to_string()];
		let pipeline = AutomationPipeline {
			steps: vec![AutomationStep::Rename { pattern: "batch_{index}".to_string() }],
		};
		let out = preview_automation(files, pipeline).unwrap();
		assert_eq!(out[0].output_filename, "batch_0000.png");
		assert_eq!(out[1].output_filename, "batch_0001.tga");
	}

	#[test]
	fn run_convert_and_resize_writes_outputs() {
		let tmp = tempfile::tempdir().unwrap();
		let input = tmp.path().join("input.png");
		let out_dir = tmp.path().join("out");
		fs::create_dir_all(&out_dir).unwrap();
		image::RgbaImage::new(16, 16).save(&input).unwrap();

		let pipeline = AutomationPipeline {
			steps: vec![
				AutomationStep::Resize {
					mode: "exact".to_string(),
					width: 8,
					height: 8,
					filter: "lanczos".to_string(),
				},
				AutomationStep::Convert { format: "tga".to_string(), bit_depth: 8 },
			],
		};
		process_single_file(
			input.to_str().unwrap(),
			&pipeline,
			out_dir.to_str().unwrap(),
			0,
		)
		.unwrap();

		let produced = out_dir.join("input.tga");
		assert!(produced.exists());
		let loaded = image::open(&produced).unwrap();
		assert_eq!(image::GenericImageView::dimensions(&loaded), (8, 8));
	}
}
