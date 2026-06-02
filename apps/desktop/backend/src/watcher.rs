// SPDX-License-Identifier: AGPL-3.0-or-later
//! Live filesystem watching via OS-native notification primitives (inotify on
//! Linux, FSEvents on macOS, ReadDirectoryChangesW on Windows) through the
//! `notify` crate. Events are coalesced by `notify-debouncer-mini` so a burst
//! of writes (e.g., copying a folder of 10k files) produces a single fired
//! batch rather than 10k callbacks. After each batch lands, we resolve which
//! library root each event belongs to and enqueue a background *targeted*
//! update per affected root via `library::spawn_targeted_update`, handing it
//! the specific changed paths.
//!
//! The targeted update touches only the changed rows (see
//! `indexer::update_paths`) instead of walking the whole tree, so editing a
//! file in a large library no longer stat-walks every file on every save. It
//! falls back to a full `scan_root` when the change set is ambiguous (a
//! directory was created/moved/deleted, or the batch is large).

use crate::library;
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

/// Quiet-period after the last event before a batch is delivered. Long
/// enough to absorb most bulk-copy bursts; short enough that single drops
/// feel "live" (results land in the library within a couple of seconds).
const DEBOUNCE: Duration = Duration::from_millis(1500);

/// Holds the active debouncer and the watched-path → root_id map.
pub struct FileWatcher {
	debouncer: Debouncer<RecommendedWatcher>,
	roots: Arc<Mutex<HashMap<PathBuf, i64>>>,
}

pub struct WatcherState(pub Mutex<FileWatcher>);

impl FileWatcher {
	pub fn new(app: AppHandle) -> Result<Self, String> {
		let roots: Arc<Mutex<HashMap<PathBuf, i64>>> = Arc::new(Mutex::new(HashMap::new()));
		let roots_for_cb = roots.clone();

		let debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| {
			let events = match result {
				Ok(es) => es,
				Err(err) => {
					tracing::warn!("watcher error: {err:?}");
					return;
				}
			};
			let guard = match roots_for_cb.lock() {
				Ok(g) => g,
				Err(e) => {
					tracing::error!("watcher: roots lock poisoned: {e}");
					return;
				}
			};
			// Group events by affected root: the longest-matching watched root
			// prefix, accumulating the changed paths under each.
			let mut affected: HashMap<i64, (PathBuf, Vec<PathBuf>)> = HashMap::new();
			for event in events {
				let mut best_len: usize = 0;
				let mut best: Option<(i64, PathBuf)> = None;
				for (root_path, root_id) in guard.iter() {
					if event.path.starts_with(root_path) {
						let len = root_path.as_os_str().len();
						if best.is_none() || len > best_len {
							best_len = len;
							best = Some((*root_id, root_path.clone()));
						}
					}
				}
				if let Some((id, p)) = best {
					affected
						.entry(id)
						.or_insert_with(|| (p, Vec::new()))
						.1
						.push(event.path.clone());
				}
			}
			drop(guard);

			for (id, (root_path, paths)) in affected {
				tracing::debug!(
					"watcher: {} change(s) in root_id={} → targeted update",
					paths.len(),
					id
				);
				library::spawn_targeted_update(app.clone(), id, root_path, paths);
			}
		})
		.map_err(|e| format!("watcher init: {e}"))?;

		Ok(FileWatcher { debouncer, roots })
	}

	pub fn watch(&mut self, root_id: i64, path: &Path) -> Result<(), String> {
		self.debouncer
			.watcher()
			.watch(path, RecursiveMode::Recursive)
			.map_err(|e| format!("watcher: failed to watch {path:?}: {e}"))?;
		self.roots
			.lock()
			.map_err(|e| format!("watcher: roots lock poisoned: {e}"))?
			.insert(path.to_path_buf(), root_id);
		tracing::info!("watcher: watching root_id={} path={:?}", root_id, path);
		Ok(())
	}

	pub fn unwatch_root(&mut self, root_id: i64) -> Result<(), String> {
		let mut guard = self
			.roots
			.lock()
			.map_err(|e| format!("watcher: roots lock poisoned: {e}"))?;
		let path = guard
			.iter()
			.find(|(_, id)| **id == root_id)
			.map(|(p, _)| p.clone());
		if let Some(path) = path {
			let _ = self.debouncer.watcher().unwatch(&path);
			guard.remove(&path);
			tracing::info!("watcher: unwatched root_id={}", root_id);
		}
		Ok(())
	}
}
