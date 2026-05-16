// SPDX-License-Identifier: AGPL-3.0-or-later
//! Lightweight startup-timing breakdown. We've been chasing a slow-startup
//! issue with too many speculative fixes and not enough data, so this module
//! makes it cheap to instrument named phases during boot and surfaces the
//! result two ways: logged to stdout in human-readable form, and dumped to
//! `$XDG_CONFIG_HOME/garnet/startup-timings.json` so the most recent run is
//! inspectable after the fact (inspired by Obsidian's startup breakdown).
//!
//! Usage:
//! ```
//! let timings = Arc::new(StartupTimings::new());
//! let db = timings.time("open and migrate DB", db::open_and_migrate)?;
//! timings.time_with_note("watch roots", || {
//!     // ... work ...
//!     (Ok(()), Some(format!("{} roots", root_count)))
//! });
//! timings.finalize_and_save();
//! ```

use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(Serialize, serde::Deserialize, Clone)]
pub struct PhaseRecord {
	pub name: String,
	/// Milliseconds from `StartupTimings::new()` until this phase began.
	pub start_offset_ms: u128,
	pub duration_ms: u128,
	pub note: Option<String>,
}

#[derive(Serialize, serde::Deserialize)]
pub struct StartupReport {
	pub recorded_at_unix_ms: u128,
	pub total_ms: u128,
	/// The "everything should be done by now" deadline the frontend hands us
	/// when it finalizes — `SPLASH_MIN_MS + SPLASH_FADE_MS`. Used in the
	/// Stats UI to flag startups that overshot. None if the frontend didn't
	/// supply one (e.g., an older finalize path or a backend-only finalize
	/// call somewhere we add later).
	pub splash_budget_ms: Option<u128>,
	pub phases: Vec<PhaseRecord>,
}

pub struct StartupTimings {
	start: Instant,
	phases: Mutex<Vec<PhaseRecord>>,
	splash_budget_ms: Mutex<Option<u128>>,
}

impl StartupTimings {
	pub fn new() -> Self {
		Self {
			start: Instant::now(),
			phases: Mutex::new(Vec::new()),
			splash_budget_ms: Mutex::new(None),
		}
	}

	pub fn set_splash_budget(&self, budget_ms: u128) {
		if let Ok(mut g) = self.splash_budget_ms.lock() {
			*g = Some(budget_ms);
		}
	}

	/// Run `f`, recording how long it took under `name`.
	pub fn time<R>(&self, name: impl Into<String>, f: impl FnOnce() -> R) -> R {
		let name = name.into();
		let start_offset_ms = self.start.elapsed().as_millis();
		let phase_start = Instant::now();
		let result = f();
		let duration_ms = phase_start.elapsed().as_millis();
		self.push(PhaseRecord { name, start_offset_ms, duration_ms, note: None });
		result
	}

	/// Same as `time` but `f` can return a contextual note (e.g. count of
	/// items processed) that gets attached to the phase record.
	pub fn time_with_note<R>(
		&self,
		name: impl Into<String>,
		f: impl FnOnce() -> (R, Option<String>),
	) -> R {
		let name = name.into();
		let start_offset_ms = self.start.elapsed().as_millis();
		let phase_start = Instant::now();
		let (result, note) = f();
		let duration_ms = phase_start.elapsed().as_millis();
		self.push(PhaseRecord { name, start_offset_ms, duration_ms, note });
		result
	}

	/// Records a sparse checkpoint reached at "now". The phase's
	/// `start_offset_ms` is the end of the previous phase (or 0 if none), and
	/// its `duration_ms` is the gap to now — useful for events we can't wrap
	/// in a closure (e.g. webview reaching the frontend script, React's first
	/// paint) where we only know the moment of arrival.
	pub fn checkpoint(&self, name: impl Into<String>, note: Option<String>) {
		let now = self.start.elapsed().as_millis();
		let last_end = match self.phases.lock() {
			Ok(g) => g.last().map(|p| p.start_offset_ms + p.duration_ms).unwrap_or(0),
			Err(_) => 0,
		};
		let duration_ms = now.saturating_sub(last_end);
		self.push(PhaseRecord {
			name: name.into(),
			start_offset_ms: last_end,
			duration_ms,
			note,
		});
	}

	fn push(&self, record: PhaseRecord) {
		match self.phases.lock() {
			Ok(mut g) => g.push(record),
			Err(e) => tracing::warn!("startup-timing: phase lock poisoned: {e}"),
		}
	}

	pub fn finalize(&self) -> StartupReport {
		let total_ms = self.start.elapsed().as_millis();
		let phases = match self.phases.lock() {
			Ok(g) => g.clone(),
			Err(e) => {
				tracing::warn!("startup-timing: phase lock poisoned on finalize: {e}");
				Vec::new()
			}
		};
		let splash_budget_ms = self.splash_budget_ms.lock().ok().and_then(|g| *g);
		let recorded_at_unix_ms = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map(|d| d.as_millis())
			.unwrap_or(0);
		StartupReport { recorded_at_unix_ms, total_ms, splash_budget_ms, phases }
	}

	/// Snapshot phases, log a summary, and write the JSON breakdown next to
	/// the settings file. Best-effort — any failure is logged but never
	/// blocks startup.
	pub fn finalize_and_save(&self) {
		let report = self.finalize();
		log_summary(&report);
		match save_report(&report) {
			Ok(path) => tracing::info!("startup-timing: report saved to {}", path.display()),
			Err(e) => tracing::warn!("startup-timing: save failed: {e}"),
		}
	}
}

fn log_summary(report: &StartupReport) {
	tracing::info!("startup-timing: total {} ms across {} phase(s)", report.total_ms, report.phases.len());
	for p in &report.phases {
		let note = p.note.as_deref().map(|n| format!(" — {n}")).unwrap_or_default();
		tracing::info!(
			"startup-timing:   +{:>5}ms  {:>5}ms  {}{}",
			p.start_offset_ms, p.duration_ms, p.name, note,
		);
	}
}

fn save_report(report: &StartupReport) -> Result<PathBuf, String> {
	let path = report_path()?;
	let json = serde_json::to_string_pretty(report).map_err(|e| e.to_string())?;
	std::fs::write(&path, json).map_err(|e| e.to_string())?;
	Ok(path)
}

fn report_path() -> Result<PathBuf, String> {
	let dir = dirs::config_dir().ok_or_else(|| "no config dir".to_string())?.join("garnet");
	std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
	Ok(dir.join("startup-timings.json"))
}

/// Newtype wrapper so Tauri's state map can resolve `State<StartupTimingsState>`.
pub struct StartupTimingsState(pub Arc<StartupTimings>);

/// Called by the frontend at key milestones during boot (script loaded,
/// React mounted, initial data ready, splash dismissed). The backend has no
/// visibility into the webview's progress otherwise; these checkpoints are
/// how we see whether the freeze is in JS parse, React mount, IPC, etc.
#[tauri::command]
pub fn mark_startup_phase(
	name: String,
	note: Option<String>,
	state: State<StartupTimingsState>,
) -> Result<(), String> {
	state.0.checkpoint(name, note);
	Ok(())
}

/// Called by the frontend once it considers boot complete (after the splash
/// fades). Logs + writes the JSON breakdown so the Stats page can show it.
/// Idempotent — extra calls just produce extra writes with the same data.
///
/// `splash_budget_ms` is the time-budget the splash represents
/// (SPLASH_MIN_MS + SPLASH_FADE_MS in App.tsx). The Stats UI uses it to flag
/// startups that overshot.
#[tauri::command]
pub fn finalize_startup_timings(
	splash_budget_ms: Option<u32>,
	state: State<StartupTimingsState>,
) -> Result<(), String> {
	if let Some(budget) = splash_budget_ms {
		state.0.set_splash_budget(budget as u128);
	}
	state.0.finalize_and_save();
	Ok(())
}

/// Tauri command for the Stats page. Returns `Ok(None)` when the report file
/// doesn't exist yet (e.g., first launch on a previous build, or an aborted
/// startup that never reached finalize).
#[tauri::command]
pub fn get_startup_timings() -> Result<Option<StartupReport>, String> {
	let path = report_path()?;
	if !path.exists() {
		return Ok(None);
	}
	let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
	let report: StartupReport = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
	Ok(Some(report))
}
