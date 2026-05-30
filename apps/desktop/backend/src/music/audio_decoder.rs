// SPDX-License-Identifier: AGPL-3.0-or-later
//! Symphonia-backed `rodio::Source` with native seek.
//!
//! rodio's bundled `Decoder` doesn't reliably reposition the audio stream on
//! `try_seek` for some formats (the visual jump lands but audio keeps playing
//! from the old position), and the decode-and-discard fallback throws away
//! every sample from t=0 up to the requested start. `SymphoniaSource` drives
//! `FormatReader::seek` directly — for FLAC the seek table makes this
//! O(milliseconds) regardless of offset — and implements `rodio::Source` so it
//! drops straight into the existing Sink.
//!
//! Sample format is `i16` for parity with rodio's default Decoder output.
//! (Adapted from Starling's audio engine.)

use std::fs::File;
use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, Result};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

pub struct SymphoniaSource {
	reader: Box<dyn FormatReader>,
	decoder: Box<dyn Decoder>,
	track_id: u32,
	sample_rate: u32,
	channels: u16,
	total_duration: Option<Duration>,
	/// Decoded samples from the most recent packet, interleaved. Lazily
	/// allocated on the first decode (we don't know the AudioBuffer spec until
	/// then).
	sample_buf: Option<SampleBuffer<i16>>,
	sample_pos: usize,
	exhausted: bool,
}

impl SymphoniaSource {
	pub fn new(path: impl AsRef<Path>, start_seconds: f64) -> Result<Self> {
		let path = path.as_ref();
		let file = File::open(path)?;
		let mss = MediaSourceStream::new(Box::new(file), Default::default());

		let mut hint = Hint::new();
		if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
			hint.with_extension(ext);
		}

		let probed = symphonia::default::get_probe().format(
			&hint,
			mss,
			&FormatOptions::default(),
			&MetadataOptions::default(),
		)?;
		let mut reader = probed.format;

		let track = reader
			.tracks()
			.iter()
			.find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
			.ok_or_else(|| anyhow!("no decodable track in {}", path.display()))?;
		let track_id = track.id;
		let codec_params = track.codec_params.clone();

		let sample_rate = codec_params
			.sample_rate
			.ok_or_else(|| anyhow!("missing sample rate"))?;
		let channels = codec_params
			.channels
			.ok_or_else(|| anyhow!("missing channel layout"))?
			.count() as u16;
		let total_duration = codec_params
			.n_frames
			.map(|n| Duration::from_secs_f64(n as f64 / sample_rate as f64));

		let mut decoder =
			symphonia::default::get_codecs().make(&codec_params, &DecoderOptions::default())?;

		if start_seconds > 0.0 {
			// Accurate seek decodes back from the nearest seek point so we land
			// exactly on the requested time.
			reader.seek(
				SeekMode::Accurate,
				SeekTo::Time {
					time: Time::from(start_seconds),
					track_id: Some(track_id),
				},
			)?;
			// Required by Symphonia after a FormatReader seek so the decoder
			// discards any spliced-packet state.
			decoder.reset();
		}

		Ok(Self {
			reader,
			decoder,
			track_id,
			sample_rate,
			channels,
			total_duration,
			sample_buf: None,
			sample_pos: 0,
			exhausted: false,
		})
	}

	/// Pull the next packet for our track and refill the sample buffer. Returns
	/// false on EOF or unrecoverable error.
	fn refill(&mut self) -> bool {
		loop {
			let packet = match self.reader.next_packet() {
				Ok(p) => p,
				Err(SymphoniaError::IoError(e))
					if e.kind() == std::io::ErrorKind::UnexpectedEof =>
				{
					return false;
				}
				Err(e) => {
					tracing::warn!("audio_decoder: reader error: {e}");
					return false;
				}
			};
			if packet.track_id() != self.track_id {
				continue;
			}
			match self.decoder.decode(&packet) {
				Ok(decoded) => {
					let spec = *decoded.spec();
					let capacity = decoded.capacity() as u64;
					let buf = self
						.sample_buf
						.get_or_insert_with(|| SampleBuffer::<i16>::new(capacity, spec));
					buf.copy_interleaved_ref(decoded);
					self.sample_pos = 0;
					return true;
				}
				// Symphonia's recommended pattern: decode errors are non-fatal
				// (skip the bad packet, continue).
				Err(SymphoniaError::DecodeError(e)) => {
					tracing::debug!("audio_decoder: decode error (skipped): {e}");
					continue;
				}
				Err(SymphoniaError::ResetRequired) => {
					self.decoder.reset();
					continue;
				}
				Err(e) => {
					tracing::warn!("audio_decoder: fatal decoder error: {e}");
					return false;
				}
			}
		}
	}
}

impl Iterator for SymphoniaSource {
	type Item = i16;

	fn next(&mut self) -> Option<i16> {
		loop {
			if let Some(buf) = &self.sample_buf {
				let samples = buf.samples();
				if self.sample_pos < samples.len() {
					let s = samples[self.sample_pos];
					self.sample_pos += 1;
					return Some(s);
				}
			}
			if self.exhausted {
				return None;
			}
			if !self.refill() {
				self.exhausted = true;
				return None;
			}
		}
	}
}

impl rodio::Source for SymphoniaSource {
	fn current_frame_len(&self) -> Option<usize> {
		// `None` means "channels/sample_rate are stable for the foreseeable
		// future," true for a single-track file.
		None
	}

	fn channels(&self) -> u16 {
		self.channels
	}

	fn sample_rate(&self) -> u32 {
		self.sample_rate
	}

	fn total_duration(&self) -> Option<Duration> {
		self.total_duration
	}
}
