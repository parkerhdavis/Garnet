// SPDX-License-Identifier: AGPL-3.0-or-later
// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod library;
mod modules;
mod settings;

use library::{
	list_library_roots, register_library_root, remove_library_root, scan_library_root,
};
use modules::list_modules;
use settings::{load_settings, save_settings};
use std::sync::Mutex;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

pub struct AppState {
	pub db: Mutex<rusqlite::Connection>,
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

	tauri::Builder::default()
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_fs::init())
		.plugin(tauri_plugin_opener::init())
		.manage(AppState { db: Mutex::new(db) })
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
			list_modules,
		])
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
