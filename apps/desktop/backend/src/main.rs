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
use std::time::Duration;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

// Hard ceiling on how long the splash window can sit before we show the main
// window anyway — keeps a frontend crash or stuck query from leaving the user
// staring at a splash forever.
const SPLASH_SAFETY_TIMEOUT_SECS: u64 = 15;

pub struct AppState {
	pub db: Mutex<rusqlite::Connection>,
	pub media_port: u16,
}

#[tauri::command]
fn get_media_port(state: tauri::State<AppState>) -> u16 {
	state.media_port
}

/// Called by the React app once its first library/assets queries have landed
/// (plus a minimum dwell time so the splash never flashes out instantly).
/// Closes the splash window and shows the main one. Bundling both side effects
/// in a single Rust command keeps the frontend free of `core:window:*`
/// capability scopes.
#[tauri::command]
fn frontend_ready(app: tauri::AppHandle) {
	if let Some(splash) = app.get_webview_window("splash") {
		let _ = splash.close();
	}
	if let Some(main) = app.get_webview_window("main") {
		let _ = main.show();
		let _ = main.set_focus();
	}
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

			// Safety: dismiss the splash and show the main window after a hard
			// ceiling even if the frontend never calls `frontend_ready`.
			let handle = app.handle().clone();
			tauri::async_runtime::spawn(async move {
				tokio::time::sleep(Duration::from_secs(SPLASH_SAFETY_TIMEOUT_SECS)).await;
				if let Some(main) = handle.get_webview_window("main") {
					if !main.is_visible().unwrap_or(true) {
						tracing::warn!(
							"splash safety timeout fired — showing main window without frontend_ready"
						);
						let _ = main.show();
						let _ = main.set_focus();
					}
				}
				if let Some(splash) = handle.get_webview_window("splash") {
					let _ = splash.close();
				}
			});

			Ok(())
		})
		.on_window_event(|window, event| {
			// Only persist the main window's dimensions — the splash window's
			// fixed 420×320 isn't worth restoring on next launch.
			if window.label() != "main" {
				return;
			}
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
			frontend_ready,
		])
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
