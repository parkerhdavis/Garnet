// SPDX-License-Identifier: AGPL-3.0-or-later
//! Waveform peaks for the Music Library. Native playback (see `audio.rs`) means
//! the webview never decodes the audio, but we still want a waveform — so we
//! decode the file once, bucket it into abs-max peaks, and hand the frontend a
//! small `Vec<f32>` that wavesurfer renders directly (peaks-only mode).
//!
//! Peaks are computed lazily on first request and cached as JSON under
//! `$XDG_CACHE_HOME/garnet/peaks/`, keyed by source path + mtime + bucket count
//! — so we never write into the user's music folders (Garnet surfaces over
//! local files; it never ingests). Each peak is the maximum absolute amplitude
//! in `[0.0, 1.0]` across one bucket; multi-channel audio is downmixed to mono
//! by averaging. (Decoder adapted from Starling's peaks module.)

use std::fs::File;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Default bucket count: ~2-3 px per peak at a 4K width — plenty for an
/// unzoomed waveform, small enough that the payload stays tiny.
pub const DEFAULT_PEAKS: usize = 2000;
pub const PEAKS_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PeaksFile {
	version: u32,
	buckets: usize,
	peaks: Vec<f32>,
}

#[derive(Debug, thiserror::Error)]
pub enum PeaksError {
	#[error("io error: {0}")]
	Io(#[from] std::io::Error),
	#[error("decode error: {0}")]
	Decode(String),
	#[error("file produced zero samples")]
	Empty,
}

impl From<SymphoniaError> for PeaksError {
	fn from(e: SymphoniaError) -> Self {
		PeaksError::Decode(e.to_string())
	}
}

fn cache_dir() -> Result<PathBuf, String> {
	let base = dirs::cache_dir().ok_or_else(|| "no cache dir".to_string())?;
	let dir = base.join("garnet").join("peaks");
	std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
	Ok(dir)
}

fn cache_key(abs_path: &str, mtime: Option<i64>, buckets: usize) -> String {
	let mut h = Sha256::new();
	h.update(abs_path.as_bytes());
	h.update(b"|");
	h.update(mtime.unwrap_or(0).to_le_bytes());
	h.update(b"|");
	h.update((buckets as u64).to_le_bytes());
	hex::encode(h.finalize())
}

/// Return waveform peaks for an audio file, computing + caching on first call.
/// The decode is a full-file pass, so it runs on the blocking pool — never on a
/// runtime worker — so it can't stall the lightweight transport commands
/// (audio_play etc.) that need to fire the instant a track is double-clicked.
#[tauri::command]
pub async fn get_audio_peaks(
	abs_path: String,
	mtime: Option<i64>,
	buckets: Option<usize>,
) -> Result<Vec<f32>, String> {
	tauri::async_runtime::spawn_blocking(move || get_audio_peaks_sync(abs_path, mtime, buckets))
		.await
		.map_err(|e| format!("peaks task failed: {e}"))?
}

fn get_audio_peaks_sync(
	abs_path: String,
	mtime: Option<i64>,
	buckets: Option<usize>,
) -> Result<Vec<f32>, String> {
	let buckets = buckets.unwrap_or(DEFAULT_PEAKS).clamp(64, 8000);
	let cache_file = cache_dir()?.join(format!("{}.json", cache_key(&abs_path, mtime, buckets)));

	if let Ok(bytes) = std::fs::read(&cache_file) {
		if let Ok(pf) = serde_json::from_slice::<PeaksFile>(&bytes) {
			if pf.version == PEAKS_VERSION && pf.buckets == buckets {
				return Ok(pf.peaks);
			}
		}
	}

	let peaks = compute_peaks(Path::new(&abs_path), buckets).map_err(|e| e.to_string())?;
	if let Ok(bytes) = serde_json::to_vec(&PeaksFile {
		version: PEAKS_VERSION,
		buckets,
		peaks: peaks.clone(),
	}) {
		let _ = std::fs::write(&cache_file, bytes);
	}
	Ok(peaks)
}

/// Decode the file and bucket it into `target` (or fewer, for very short files)
/// abs-max peaks.
fn compute_peaks(audio_path: &Path, target: usize) -> Result<Vec<f32>, PeaksError> {
	let mono = decode_mono(audio_path)?;
	if mono.is_empty() {
		return Err(PeaksError::Empty);
	}
	Ok(bucket_peaks(&mono, target))
}

/// Pure: bucket a sample series into `target` abs-max peaks.
fn bucket_peaks(samples: &[f32], target: usize) -> Vec<f32> {
	let target = target.max(1);
	let bucket_size = samples.len().div_ceil(target).max(1);
	let mut peaks = Vec::with_capacity(target);
	for chunk in samples.chunks(bucket_size) {
		let max = chunk.iter().fold(0.0f32, |m, &s| s.abs().max(m));
		peaks.push(max);
	}
	peaks
}

/// Decode `audio_path` to a mono f32 sample series (channel-averaged).
fn decode_mono(audio_path: &Path) -> Result<Vec<f32>, PeaksError> {
	let file = File::open(audio_path)?;
	let mss = MediaSourceStream::new(Box::new(file), Default::default());
	let hint = Hint::new();
	let probed = symphonia::default::get_probe().format(
		&hint,
		mss,
		&FormatOptions::default(),
		&MetadataOptions::default(),
	)?;
	let mut format = probed.format;
	let track = format
		.default_track()
		.ok_or_else(|| PeaksError::Decode("no default track".into()))?;
	let track_id = track.id;
	let codec_params = &track.codec_params;
	let mut decoder =
		symphonia::default::get_codecs().make(codec_params, &DecoderOptions::default())?;

	let mut mono_samples: Vec<f32> = Vec::new();
	loop {
		let packet = match format.next_packet() {
			Ok(p) => p,
			Err(SymphoniaError::IoError(ref e))
				if e.kind() == std::io::ErrorKind::UnexpectedEof =>
			{
				break;
			}
			Err(SymphoniaError::ResetRequired) => {
				decoder.reset();
				continue;
			}
			Err(e) => return Err(e.into()),
		};
		if packet.track_id() != track_id {
			continue;
		}
		match decoder.decode(&packet) {
			Ok(buffer) => append_mono(&mut mono_samples, buffer),
			Err(SymphoniaError::DecodeError(_)) => continue,
			Err(SymphoniaError::IoError(_)) => break,
			Err(e) => return Err(e.into()),
		}
	}
	Ok(mono_samples)
}

/// Downmix any Symphonia [`AudioBufferRef`] variant to mono and append to `out`.
fn append_mono(out: &mut Vec<f32>, buffer: AudioBufferRef<'_>) {
	use symphonia::core::audio::AudioBufferRef::*;
	macro_rules! mix {
		($buf:expr, $convert:expr) => {{
			let buf = $buf;
			let frames = buf.frames();
			let channels = buf.spec().channels.count();
			out.reserve(frames);
			for f in 0..frames {
				let mut sum = 0.0f32;
				for c in 0..channels {
					let s = buf.chan(c)[f];
					sum += $convert(s);
				}
				out.push(sum / channels as f32);
			}
		}};
	}
	match buffer {
		U8(b) => mix!(b, |s: u8| (s as f32 - 128.0) / 128.0),
		U16(b) => mix!(b, |s: u16| (s as f32 - 32768.0) / 32768.0),
		U24(b) => mix!(b, |s: symphonia::core::sample::u24| {
			let v = s.inner() as f32 - 8_388_608.0;
			v / 8_388_608.0
		}),
		U32(b) => mix!(b, |s: u32| (s as f64 - 2_147_483_648.0) as f32 / 2_147_483_648.0),
		S8(b) => mix!(b, |s: i8| s as f32 / 128.0),
		S16(b) => mix!(b, |s: i16| s as f32 / 32768.0),
		S24(b) => mix!(b, |s: symphonia::core::sample::i24| s.inner() as f32 / 8_388_608.0),
		S32(b) => mix!(b, |s: i32| s as f64 as f32 / 2_147_483_648.0),
		F32(b) => mix!(b, |s: f32| s),
		F64(b) => mix!(b, |s: f64| s as f32),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn bucket_peaks_counts_and_takes_abs_max() {
		// 6 samples into 3 buckets → bucket_size = 2.
		let samples = vec![0.0, -0.5, 0.25, 1.0, -0.75, 0.1];
		let peaks = bucket_peaks(&samples, 3);
		assert_eq!(peaks.len(), 3);
		assert!((peaks[0] - 0.5).abs() < 1e-6);
		assert!((peaks[1] - 1.0).abs() < 1e-6);
		assert!((peaks[2] - 0.75).abs() < 1e-6);
	}

	#[test]
	fn bucket_peaks_never_exceeds_sample_count() {
		// Fewer samples than target buckets → one bucket per sample.
		let peaks = bucket_peaks(&[0.3, -0.9], 100);
		assert_eq!(peaks.len(), 2);
	}
}
