// SPDX-License-Identifier: AGPL-3.0-or-later
//! Live filesystem watching via OS-native notification primitives (inotify on
//! Linux, FSEvents on macOS, ReadDirectoryChangesW on Windows) through the
//! `notify` crate. Events are coalesced by `notify-debouncer-mini` so a burst
//! of writes (e.g., copying a folder of 10k files) produces a single fired
//! batch rather than 10k callbacks. After each batch lands, we resolve which
//! library root each event belongs to and enqueue one background scan per
//! affected root via `library::spawn_scan`.
//!
//! Reuses the existing scan pipeline rather than reinventing per-event
//! updates: the indexer's diff-aware scan (size+mtime fast path, blake3 for
//! renames/modifications) skips unchanged files cheaply, so a "scan everything
//! when anything changes" approach is acceptable for V1 and keeps the code
//! simple. We can layer in event-targeted updates later if scan throughput
//! becomes a bottleneck.

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
			// Group events by affected root. For each event, find the longest-
			// matching watched root prefix and remember the (id, path).
			let mut affected: HashMap<i64, PathBuf> = HashMap::new();
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
					affected.insert(id, p);
				}
			}
			drop(guard);

			for (id, path) in affected {
				tracing::debug!("watcher: change in root_id={} triggering scan", id);
				library::spawn_scan(app.clone(), id, path);
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
