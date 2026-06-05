// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared ffmpeg / ffprobe shell-out helpers.
//!
//! Garnet does not bundle or link ffmpeg — it shells out to the system
//! binaries when they're on `PATH` (probed by `make setup`). Two consumers
//! need the same plumbing: thumbnail generation (`thumbnails.rs`) and the
//! video editor (`video_editor.rs`). Rather than duplicate the availability
//! probe and the concurrency limiter, they live here.
//!
//! - `ffmpeg_available` / `ffprobe_available` — one-time `… -version` probe,
//!   cached in an `OnceLock`. Cheap to call repeatedly.
//! - `ffmpeg_slot` — a process-wide counting semaphore (4 slots) so a burst
//!   of work (a grid of 60 video thumbnails, or a scroll that fires many
//!   `video_info` probes) doesn't spawn one ffmpeg per item and oversubscribe
//!   the CPU. The first few items fill in fast (the user-facing perception)
//!   without sacrificing total throughput. Image decodes have their own
//!   separate budget in `thumbnails.rs`.

use std::process::Command;
use std::sync::{Mutex, OnceLock};

/// Cap on concurrent ffmpeg/ffprobe subprocesses. A full grid of 60 video
/// tiles otherwise spawns 60 processes at once and each decode runs at
/// 1/60th speed from CPU oversubscription. A small handful lets the first
/// few items fill in fast without hurting total throughput meaningfully.
const FFMPEG_PARALLELISM: usize = 4;

/// True if `ffmpeg` is on `PATH` and runs. Probed once and cached.
pub fn ffmpeg_available() -> bool {
	static AVAILABLE: OnceLock<bool> = OnceLock::new();
	*AVAILABLE.get_or_init(|| {
		Command::new("ffmpeg")
			.arg("-version")
			.output()
			.map(|o| o.status.success())
			.unwrap_or(false)
	})
}

/// True if `ffprobe` is on `PATH` and runs. Probed once and cached.
/// `ffprobe` ships in the same package as `ffmpeg`, but probe it separately
/// so a partial install surfaces the right error.
pub fn ffprobe_available() -> bool {
	static AVAILABLE: OnceLock<bool> = OnceLock::new();
	*AVAILABLE.get_or_init(|| {
		Command::new("ffprobe")
			.arg("-version")
			.output()
			.map(|o| o.status.success())
			.unwrap_or(false)
	})
}

/// Counting-semaphore permit. A `Mutex<usize>` plus a small backoff loop —
/// std doesn't ship `Semaphore` and the queue here is small enough that a
/// token-counter under a regular mutex is fine. The blocking pool has more
/// threads than we'd ever park, so this is safe.
#[must_use]
pub struct Permit {
	slots: &'static Mutex<usize>,
}
impl Drop for Permit {
	fn drop(&mut self) {
		if let Ok(mut g) = self.slots.lock() {
			*g += 1;
		}
	}
}

/// Acquire one token from `slot`, spin-waiting (20ms backoff) until one frees.
/// Safe to call from the blocking pool only — never from an async context.
/// `pub(crate)` so `thumbnails.rs` can reuse it for its image-decode budget.
pub(crate) fn acquire(slot: &'static Mutex<usize>) -> Permit {
	loop {
		{
			let mut g = match slot.lock() {
				Ok(g) => g,
				Err(_) => return Permit { slots: slot },
			};
			if *g > 0 {
				*g -= 1;
				return Permit { slots: slot };
			}
		}
		std::thread::sleep(std::time::Duration::from_millis(20));
	}
}

/// Acquire an ffmpeg/ffprobe slot, blocking until one is free. Hold the
/// returned `Permit` for the duration of the subprocess; dropping it releases
/// the slot.
pub fn ffmpeg_slot() -> Permit {
	static AVAILABLE: OnceLock<Mutex<usize>> = OnceLock::new();
	acquire(AVAILABLE.get_or_init(|| Mutex::new(FFMPEG_PARALLELISM)))
}
