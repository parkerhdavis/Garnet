// SPDX-License-Identifier: AGPL-3.0-or-later
// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod db;
mod indexer;
mod library;
mod media_server;
mod modules;
mod settings;
mod tags;
mod thumbnails;

use assets::{get_asset, list_asset_formats, list_assets};
use library::{
	list_library_roots, register_library_root, remove_library_root, scan_library_root,
};
use modules::list_modules;
use settings::{load_settings, save_settings};
use tags::{
	create_tag, delete_tag, list_asset_metadata, list_asset_tags, list_tags, tag_asset,
	untag_asset,
};
use thumbnails::get_thumbnail;
use std::sync::Mutex;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

pub struct AppState {
	pub db: Mutex<rusqlite::Connection>,
	pub media_port: u16,
}

#[tauri::command]
fn get_media_port(state: tauri::State<AppState>) -> u16 {
	state.media_port
}

fn init_logging() {
	let log_dir = match dirs::config_dir() {
		Some(d) => d.join("garnet").join("logs"),
		None => {
			eprintln!("Warning: could not determine config directory, logging to /tmp/garnet/logs");
			std::path::PathBuf::from("/tmp/garnet/logs")
		}
	};
	std::fs::create_dir_all(&log_dir).ok();

	let file_appender = tracing_appender::rolling::daily(&log_dir, "garnet.log");

	tracing_subscriber::fmt()
		.with_env_filter(
			EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("garnet=info")),
		)
		.with_writer(file_appender)
		.with_ansi(false)
		.init();

	tracing::info!("Garnet starting up");
}

fn main() {
	init_logging();

	let db = match db::open_and_migrate() {
		Ok(c) => c,
		Err(e) => {
			tracing::error!("Failed to open database: {e:#}");
			eprintln!("Failed to open database: {e:#}");
			std::process::exit(1);
		}
	};

	let media_port = match media_server::spawn() {
		Ok(p) => p,
		Err(e) => {
			tracing::error!("Failed to start media server: {e}");
			eprintln!("Failed to start media server: {e}");
			std::process::exit(1);
		}
	};

	tauri::Builder::default()
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_fs::init())
		.plugin(tauri_plugin_opener::init())
		.manage(AppState { db: Mutex::new(db), media_port })
		.setup(|app| {
			if let Ok(settings) = settings::load_settings() {
				if let (Some(w), Some(h)) = (settings.window_width, settings.window_height) {
					if let Some(window) = app.get_webview_window("main") {
						let size = tauri::LogicalSize::new(w as f64, h as f64);
						let _ = window.set_size(size);
					}
				}
			}
			Ok(())
		})
		.on_window_event(|window, event| {
			if let tauri::WindowEvent::CloseRequested { .. } = event {
				if let Ok(size) = window.inner_size() {
					if let Ok(scale) = window.scale_factor() {
						let logical_w = (size.width as f64 / scale).round() as u32;
						let logical_h = (size.height as f64 / scale).round() as u32;
						if let Ok(mut current) = settings::load_settings() {
							current.window_width = Some(logical_w);
							current.window_height = Some(logical_h);
							let _ = settings::save_settings(current);
						}
					}
				}
			}
		})
		.invoke_handler(tauri::generate_handler![
			load_settings,
			save_settings,
			register_library_root,
			list_library_roots,
			remove_library_root,
			scan_library_root,
			list_assets,
			get_asset,
			list_asset_formats,
			list_asset_metadata,
			get_thumbnail,
			list_tags,
			create_tag,
			delete_tag,
			tag_asset,
			untag_asset,
			list_asset_tags,
			list_modules,
			get_media_port,
		])
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
