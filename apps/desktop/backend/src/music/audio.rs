// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native audio playback for the Music Library. The webview is a remote
//! control; this module owns the actual playback path.
//!
//! ## Why native
//!
//! WebKitGTK's HTMLMediaElement chops/skips on compressed audio (reproducible
//! with FLAC and MP3) — a GStreamer pipeline bug we can't work around in JS.
//! Decoding and playing in Rust sidesteps the entire webview media path.
//! Symphonia handles decode; Rodio drives the OS audio sink via CPAL.
//!
//! ## Architecture
//!
//! A long-lived background thread owns a Rodio [`Sink`]. Tauri commands send
//! [`AudioCommand`] messages through a crossbeam channel; the thread pumps
//! pending commands then sleeps ~30ms before emitting a position event if
//! playing. (Adapted from Starling's engine, minus its clip-window plumbing —
//! the music player plays whole tracks.)

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use rodio::{OutputStream, OutputStreamHandle, Sink, Source};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::music::audio_decoder::SymphoniaSource;

/// Throttle position events to ~30 Hz so we don't flood the IPC bus. Frontend
/// interpolation between updates keeps the cursor smooth.
const POSITION_TICK: Duration = Duration::from_millis(33);

const EVT_POSITION: &str = "audio:position";
const EVT_STATE: &str = "audio:state";

/// Commands sent from Tauri command handlers into the audio thread.
#[derive(Debug)]
pub enum AudioCommand {
	/// Load a file and prepare for playback (lands paused). `volume_db` is the
	/// per-track volume override; `0.0` plays at the file's natural level.
	Load { path: PathBuf, volume_db: f32 },
	Play,
	Pause,
	/// Seek to an absolute position in seconds (clamped to ≥ 0).
	Seek(f64),
	/// Live volume change in dB without re-loading.
	SetVolume(f32),
	Stop,
}

/// Convert dB to linear amplitude. `0 dB` → `1.0`; `+6 dB` ≈ `2.0`.
fn db_to_linear(db: f32) -> f32 {
	10.0_f32.powf(db / 20.0)
}

/// Public-facing playback state. The frontend mirrors this in its player hook.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackStatus {
	Idle,
	Loaded,
	Playing,
	Paused,
	Ended,
	Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct StateEvent {
	pub status: PlaybackStatus,
	pub path: Option<String>,
	pub duration_seconds: Option<f64>,
	pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct PositionEvent {
	pub position_seconds: f64,
}

/// Sender side of the command channel; managed by Tauri as app state.
pub struct AudioCommandSender(pub Sender<AudioCommand>);

/// Spawn the audio thread. Returns the command sender so the Tauri setup hook
/// can stash it as managed state. The output stream lives on the audio thread
/// for its entire lifetime (`OutputStream` is `!Send` on some platforms).
pub fn spawn(app: AppHandle) -> AudioCommandSender {
	let (tx, rx) = crossbeam_channel::unbounded::<AudioCommand>();
	std::thread::Builder::new()
		.name("garnet-audio".into())
		.spawn(move || run(rx, app))
		.expect("spawn audio thread");
	AudioCommandSender(tx)
}

/// Audio-thread main loop.
fn run(rx: Receiver<AudioCommand>, app: AppHandle) {
	tracing::info!("audio: thread started");
	let (_stream, handle) = match OutputStream::try_default() {
		Ok(pair) => {
			tracing::info!("audio: opened default output stream");
			pair
		}
		Err(e) => {
			tracing::error!("audio: failed to open default output stream: {e}");
			emit_state(
				&app,
				StateEvent {
					status: PlaybackStatus::Error,
					path: None,
					duration_seconds: None,
					error: Some(format!("failed to open audio output: {e}")),
				},
			);
			return;
		}
	};

	let mut player = Player::new(handle);
	let mut last_position_emit = Instant::now();

	loop {
		// Block briefly so an idle thread doesn't spin.
		let timeout = if player.is_playing() {
			POSITION_TICK
		} else {
			Duration::from_millis(250)
		};
		match rx.recv_timeout(timeout) {
			Ok(cmd) => handle_command(&mut player, &app, cmd),
			Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
			Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
				tracing::info!("audio: command channel closed, exiting thread");
				return;
			}
		}

		// Emit an `Ended` state once playback runs off the end of the track.
		if player.check_ended() {
			emit_state(
				&app,
				StateEvent {
					status: PlaybackStatus::Ended,
					path: player.path_string(),
					duration_seconds: player.duration_seconds(),
					error: None,
				},
			);
		}

		// Emit position at the throttled cadence while playing.
		if player.is_playing() && last_position_emit.elapsed() >= POSITION_TICK {
			emit_position(
				&app,
				PositionEvent {
					position_seconds: player.position_seconds(),
				},
			);
			last_position_emit = Instant::now();
		}
	}
}

fn handle_command(player: &mut Player, app: &AppHandle, cmd: AudioCommand) {
	tracing::debug!("audio: handling {cmd:?}");
	match cmd {
		AudioCommand::Load { path, volume_db } => match player.load(path.clone(), volume_db) {
			Ok(duration) => {
				tracing::info!("audio: loaded {} (duration={:.2}s)", path.display(), duration);
				emit_state(
					app,
					StateEvent {
						status: PlaybackStatus::Loaded,
						path: Some(path.to_string_lossy().into_owned()),
						duration_seconds: Some(duration),
						error: None,
					},
				);
			}
			Err(e) => {
				tracing::error!("audio: load failed for {}: {e:#}", path.display());
				emit_state(
					app,
					StateEvent {
						status: PlaybackStatus::Error,
						path: Some(path.to_string_lossy().into_owned()),
						duration_seconds: None,
						error: Some(e.to_string()),
					},
				);
			}
		},
		AudioCommand::Play => {
			player.play();
			emit_state(
				app,
				StateEvent {
					status: PlaybackStatus::Playing,
					path: player.path_string(),
					duration_seconds: player.duration_seconds(),
					error: None,
				},
			);
		}
		AudioCommand::Pause => {
			player.pause();
			emit_state(
				app,
				StateEvent {
					status: PlaybackStatus::Paused,
					path: player.path_string(),
					duration_seconds: player.duration_seconds(),
					error: None,
				},
			);
		}
		AudioCommand::Seek(seconds) => {
			if let Err(e) = player.seek(seconds) {
				tracing::warn!("audio: seek failed: {e}");
			}
			emit_position(
				app,
				PositionEvent {
					position_seconds: player.position_seconds(),
				},
			);
		}
		AudioCommand::SetVolume(db) => player.set_volume(db),
		AudioCommand::Stop => {
			player.stop();
			emit_state(
				app,
				StateEvent {
					status: PlaybackStatus::Idle,
					path: None,
					duration_seconds: None,
					error: None,
				},
			);
		}
	}
}

/// State owned by the audio thread that survives across commands. Re-created on
/// each `Load`.
struct Player {
	handle: OutputStreamHandle,
	sink: Option<Sink>,
	path: Option<PathBuf>,
	duration_seconds: Option<f64>,
	/// Wall-clock anchor: at `play_anchor`, the head was at
	/// `position_at_anchor`. Derives `position_seconds()` without polling Rodio.
	play_anchor: Option<Instant>,
	position_at_anchor: f64,
	volume_db: f32,
	/// True once we've emitted `Ended` for the current load, so the run loop
	/// emits it exactly once.
	ended_emitted: bool,
}

impl Player {
	fn new(handle: OutputStreamHandle) -> Self {
		Self {
			handle,
			sink: None,
			path: None,
			duration_seconds: None,
			play_anchor: None,
			position_at_anchor: 0.0,
			volume_db: 0.0,
			ended_emitted: false,
		}
	}

	fn load(&mut self, path: PathBuf, volume_db: f32) -> anyhow::Result<f64> {
		self.stop();
		let source = SymphoniaSource::new(&path, 0.0)?;
		let duration = Source::total_duration(&source)
			.map(|d| d.as_secs_f64())
			.unwrap_or(0.0);
		let sink = Sink::try_new(&self.handle)?;
		sink.set_volume(db_to_linear(volume_db));
		sink.append(source);
		sink.pause(); // load lands paused — caller decides when to play
		self.sink = Some(sink);
		self.path = Some(path);
		self.duration_seconds = Some(duration);
		self.play_anchor = None;
		self.position_at_anchor = 0.0;
		self.volume_db = volume_db;
		self.ended_emitted = false;
		Ok(duration)
	}

	fn set_volume(&mut self, db: f32) {
		self.volume_db = db;
		if let Some(sink) = &self.sink {
			sink.set_volume(db_to_linear(db));
		}
	}

	fn play(&mut self) {
		// Replay from the start if we're sitting at the end (after a natural
		// finish). seek() rebuilds the sink.
		if let Some(dur) = self.duration_seconds {
			if dur > 0.0 && self.position_at_anchor >= dur {
				let _ = self.seek(0.0);
			}
		}
		if let Some(sink) = &self.sink {
			sink.play();
			self.play_anchor = Some(Instant::now());
			self.ended_emitted = false;
		}
	}

	fn pause(&mut self) {
		if let Some(sink) = &self.sink {
			self.position_at_anchor = self.position_seconds();
			sink.pause();
			self.play_anchor = None;
		}
	}

	fn seek(&mut self, seconds: f64) -> anyhow::Result<()> {
		let Some(path) = self.path.clone() else {
			anyhow::bail!("nothing loaded");
		};
		let was_playing = self.is_playing();
		let clamped = seconds.max(0.0);
		let source = SymphoniaSource::new(&path, clamped)?;
		let sink = Sink::try_new(&self.handle)?;
		sink.set_volume(db_to_linear(self.volume_db));
		sink.append(source);
		if was_playing {
			sink.play();
			self.play_anchor = Some(Instant::now());
		} else {
			sink.pause();
			self.play_anchor = None;
		}
		self.sink = Some(sink);
		self.position_at_anchor = clamped;
		self.ended_emitted = false;
		Ok(())
	}

	fn stop(&mut self) {
		if let Some(sink) = self.sink.take() {
			sink.stop();
		}
		self.path = None;
		self.duration_seconds = None;
		self.play_anchor = None;
		self.position_at_anchor = 0.0;
		self.ended_emitted = false;
	}

	fn is_playing(&self) -> bool {
		self.sink
			.as_ref()
			.is_some_and(|s| !s.is_paused() && !s.empty())
	}

	fn position_seconds(&self) -> f64 {
		match self.play_anchor {
			Some(anchor) => self.position_at_anchor + anchor.elapsed().as_secs_f64(),
			None => self.position_at_anchor,
		}
	}

	fn path_string(&self) -> Option<String> {
		self.path.as_ref().map(|p| p.to_string_lossy().into_owned())
	}

	fn duration_seconds(&self) -> Option<f64> {
		self.duration_seconds
	}

	/// Returns true exactly once when the sink has drained (track finished).
	/// The run loop emits the `Ended` state on that transition.
	fn check_ended(&mut self) -> bool {
		if self.ended_emitted || self.path.is_none() {
			return false;
		}
		// A sink that was started and is now empty has played to the end. Guard
		// on having ever started (play_anchor set or position advanced) so a
		// freshly-loaded paused track isn't reported as ended.
		let started = self.play_anchor.is_some() || self.position_at_anchor > 0.0;
		let drained = self.sink.as_ref().is_some_and(|s| s.empty());
		if started && drained {
			// Snap to the end so a subsequent play() replays from 0.
			if let Some(dur) = self.duration_seconds {
				self.position_at_anchor = dur;
			}
			self.play_anchor = None;
			self.ended_emitted = true;
			return true;
		}
		false
	}
}

fn emit_state(app: &AppHandle, payload: StateEvent) {
	if let Err(e) = app.emit(EVT_STATE, &payload) {
		tracing::warn!("audio: failed to emit state event: {e}");
	}
}

fn emit_position(app: &AppHandle, payload: PositionEvent) {
	if let Err(e) = app.emit(EVT_POSITION, &payload) {
		tracing::warn!("audio: failed to emit position event: {e}");
	}
}

// ----------------------------------------------------------------------------
// Tauri commands
// ----------------------------------------------------------------------------

type CmdState<'a> = tauri::State<'a, Mutex<AudioCommandSender>>;

fn send(state: CmdState, cmd: AudioCommand) -> Result<(), String> {
	let guard = state.lock().map_err(|e| e.to_string())?;
	guard.0.send(cmd).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn audio_load(state: CmdState, path: String, volume_db: Option<f32>) -> Result<(), String> {
	send(
		state,
		AudioCommand::Load {
			path: PathBuf::from(path),
			volume_db: volume_db.unwrap_or(0.0),
		},
	)
}

#[tauri::command]
pub fn audio_set_volume(state: CmdState, volume_db: f32) -> Result<(), String> {
	send(state, AudioCommand::SetVolume(volume_db))
}

#[tauri::command]
pub fn audio_play(state: CmdState) -> Result<(), String> {
	send(state, AudioCommand::Play)
}

#[tauri::command]
pub fn audio_pause(state: CmdState) -> Result<(), String> {
	send(state, AudioCommand::Pause)
}

#[tauri::command]
pub fn audio_seek(state: CmdState, position_seconds: f64) -> Result<(), String> {
	send(state, AudioCommand::Seek(position_seconds))
}

#[tauri::command]
pub fn audio_stop(state: CmdState) -> Result<(), String> {
	send(state, AudioCommand::Stop)
}
