// SPDX-License-Identifier: AGPL-3.0-or-later
//! Video editor: the video equivalent of the image editor (`editor/`).
//!
//! Unlike the image editor — which runs a Rust pixel pipeline on an in-memory
//! `Rgba32FImage` — every video operation here is a fragment of an ffmpeg
//! command. We shell out to the system `ffmpeg`/`ffprobe` (the same posture as
//! thumbnail generation; see `crate::ffmpeg`), so there is no Rust-side video
//! codec dependency.
//!
//! Three Tauri commands mirror the editor's shape:
//!
//! - `video_info` — `ffprobe` the source for duration / dimensions / fps /
//!   codec / audio presence, to drive the timeline and tool defaults.
//! - `video_frame` — extract a single **raw** frame at a timestamp as a PNG
//!   (served to the frontend via the media server). The editor previews crop /
//!   resize / rotate / color edits *client-side* over this frame (CSS filters
//!   plus geometry wrappers, exactly like the image editor's live preview), so
//!   the extracted frame carries no operations — only an optional downscale.
//! - `commit_video_edit` — translate the whole operation list into ONE ffmpeg
//!   invocation and transcode to disk.
//!
//! Why frame-based preview instead of an inline `<video>`: on Linux webkit2gtk,
//! `<video>` playback through the asset/media path is unreliable (MediaError
//! code 4). Extracting frames sidesteps the webview's media pipeline entirely
//! and is frame-accurate and cross-platform.
//!
//! As with the image editor, the live (CSS) color preview is approximate; the
//! committed ffmpeg `eq`/`hue` math is the source of truth for the saved file.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use crate::ffmpeg::{ffmpeg_available, ffmpeg_slot, ffprobe_available};

// --------------------------------------------------------------------------
// Operations
// --------------------------------------------------------------------------

/// One pending video edit. Tagged enum (snake_case) so the frontend builds
/// `{ type, ...params }` objects, mirroring `editor::pipeline::Operation`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VideoOperation {
	/// Keep only `[start_secs, end_secs)`. Frame-accurate (we re-encode).
	Trim { start_secs: f64, end_secs: f64 },
	/// Axis-aligned crop (`x,y` = top-left, `w,h` = size), in source pixels.
	Crop { x: u32, y: u32, w: u32, h: u32 },
	/// Scale to exact pixel dimensions.
	Resize { w: u32, h: u32 },
	/// Rotate clockwise; restricted to 90° multiples (lossless transpose).
	Rotate { angle: i32 },
	/// Brightness offset in [-1, 1]; 0 = identity (maps to ffmpeg `eq=brightness`).
	AdjustBrightness { offset: f64 },
	/// Contrast amount in [-1, 1]; 0 = identity (maps to ffmpeg `eq=contrast=1+a`).
	AdjustContrast { amount: f64 },
	/// Saturation offset in [-1, 1]; 0 = identity (maps to ffmpeg `eq=saturation=1+o`).
	AdjustSaturation { offset: f64 },
	/// Hue rotation in degrees (maps to ffmpeg `hue=h`).
	AdjustHue { offset: f64 },
}

// --------------------------------------------------------------------------
// Probe (ffprobe)
// --------------------------------------------------------------------------

/// Source video facts the editor needs up front.
#[derive(Debug, Clone, Serialize)]
pub struct VideoInfo {
	pub duration_secs: f64,
	pub width: u32,
	pub height: u32,
	pub fps: f64,
	pub codec: String,
	pub has_audio: bool,
}

#[tauri::command]
pub async fn video_info(path: String) -> Result<VideoInfo, String> {
	tokio::task::spawn_blocking(move || probe_video(&path))
		.await
		.map_err(|e| format!("Task failed: {e}"))?
}

fn probe_video(path: &str) -> Result<VideoInfo, String> {
	if !ffprobe_available() {
		return Err("ffprobe not found on PATH — install ffmpeg to edit video.".into());
	}
	let _permit = ffmpeg_slot();
	let out = Command::new("ffprobe")
		.args([
			"-v",
			"quiet",
			"-print_format",
			"json",
			"-show_format",
			"-show_streams",
		])
		.arg(path)
		.output()
		.map_err(|e| format!("Failed to run ffprobe: {e}"))?;
	if !out.status.success() {
		return Err(ffmpeg_error("ffprobe failed", &out));
	}
	let v: serde_json::Value =
		serde_json::from_slice(&out.stdout).map_err(|e| format!("Bad ffprobe JSON: {e}"))?;
	parse_probe_json(&v)
}

/// Parse the loose ffprobe `-print_format json` document. Kept separate from
/// the subprocess call so it can be unit-tested against canned JSON.
fn parse_probe_json(v: &serde_json::Value) -> Result<VideoInfo, String> {
	let streams = v["streams"].as_array().ok_or("ffprobe: no streams array")?;
	let video = streams
		.iter()
		.find(|s| s["codec_type"].as_str() == Some("video"))
		.ok_or("No video stream found in file")?;
	let has_audio = streams
		.iter()
		.any(|s| s["codec_type"].as_str() == Some("audio"));

	let width = video["width"].as_u64().unwrap_or(0) as u32;
	let height = video["height"].as_u64().unwrap_or(0) as u32;
	let codec = video["codec_name"].as_str().unwrap_or("unknown").to_string();

	// fps: r_frame_rate ("30000/1001") is the authoritative nominal rate;
	// avg_frame_rate is the fallback for streams that omit it.
	let fps = video["r_frame_rate"]
		.as_str()
		.map(parse_fps)
		.filter(|f| *f > 0.0)
		.or_else(|| video["avg_frame_rate"].as_str().map(parse_fps))
		.unwrap_or(0.0);

	// Duration lives on format for most containers, but some (e.g. MKV) only
	// carry it on the stream — fall back. Both are strings ("12.345000").
	let duration_secs = v["format"]["duration"]
		.as_str()
		.and_then(|s| s.parse::<f64>().ok())
		.or_else(|| video["duration"].as_str().and_then(|s| s.parse::<f64>().ok()))
		.unwrap_or(0.0);

	Ok(VideoInfo { duration_secs, width, height, fps, codec, has_audio })
}

/// Parse an ffprobe frame-rate token: `"30000/1001"` → 29.97, `"30/1"` → 30,
/// `"30"` → 30, and anything degenerate (`"0/0"`, `"N/A"`, `""`) → 0.
fn parse_fps(s: &str) -> f64 {
	let s = s.trim();
	if let Some((n, d)) = s.split_once('/') {
		let n = n.trim().parse::<f64>().unwrap_or(0.0);
		let d = d.trim().parse::<f64>().unwrap_or(0.0);
		if d == 0.0 {
			0.0
		} else {
			n / d
		}
	} else {
		s.parse::<f64>().unwrap_or(0.0)
	}
}

// --------------------------------------------------------------------------
// Frame extraction (preview)
// --------------------------------------------------------------------------

#[tauri::command]
pub async fn video_frame(
	path: String,
	timestamp_secs: f64,
	max_dim: Option<u32>,
) -> Result<String, String> {
	tokio::task::spawn_blocking(move || extract_frame(&path, timestamp_secs, max_dim))
		.await
		.map_err(|e| format!("Task failed: {e}"))?
}

fn extract_frame(path: &str, timestamp_secs: f64, max_dim: Option<u32>) -> Result<String, String> {
	if !ffmpeg_available() {
		return Err("ffmpeg not found on PATH — install ffmpeg to edit video.".into());
	}
	let _permit = ffmpeg_slot();
	let out_path = next_vframe_path();

	let ts = if timestamp_secs.is_finite() && timestamp_secs > 0.0 {
		timestamp_secs
	} else {
		0.0
	};

	let mut cmd = Command::new("ffmpeg");
	cmd.arg("-ss").arg(fmt_num(ts)).arg("-i").arg(path);
	cmd.args(["-frames:v", "1"]);
	if let Some(m) = max_dim {
		// Only downscale (`min(m, iw)`); `-2` keeps aspect and an even height.
		// Literal single quotes protect the inner comma from ffmpeg's filter
		// lexer (same idiom as thumbnail extraction — quotes are not shell
		// quoting here, the args are passed verbatim).
		cmd.arg("-vf").arg(format!("scale='min({m},iw)':-2"));
	}
	cmd.args(["-y", "-loglevel", "error"]).arg(&out_path);

	let out = cmd
		.output()
		.map_err(|e| format!("Failed to run ffmpeg: {e}"))?;
	if !out.status.success() {
		return Err(ffmpeg_error("ffmpeg frame extraction failed", &out));
	}
	rotate_vframe_file(out_path.clone());
	Ok(out_path.to_string_lossy().into_owned())
}

/// Uniquely numbered temp path for a preview frame. Distinct prefix from the
/// image editor's `garnet-preview-*` so the two editors never collide.
fn next_vframe_path() -> PathBuf {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let n = COUNTER.fetch_add(1, Ordering::Relaxed);
	std::env::temp_dir().join(format!("garnet-vframe-{n}.png"))
}

/// Delete the previously written preview frame once a fresh one exists, so
/// /tmp holds at most one frame per editor session.
fn rotate_vframe_file(new_path: PathBuf) {
	static LAST: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
	let cell = LAST.get_or_init(|| Mutex::new(None));
	if let Ok(mut guard) = cell.lock() {
		if let Some(prev) = guard.replace(new_path) {
			let _ = std::fs::remove_file(prev);
		}
	}
}

// --------------------------------------------------------------------------
// Commit (transcode)
// --------------------------------------------------------------------------

#[tauri::command]
pub async fn commit_video_edit(
	path: String,
	ops: Vec<VideoOperation>,
	output_path: String,
	format: String,
) -> Result<(), String> {
	tokio::task::spawn_blocking(move || commit(&path, &ops, &output_path, &format))
		.await
		.map_err(|e| format!("Task failed: {e}"))?
}

fn commit(
	path: &str,
	ops: &[VideoOperation],
	output_path: &str,
	format: &str,
) -> Result<(), String> {
	if !ffmpeg_available() {
		return Err("ffmpeg not found on PATH — install ffmpeg to edit video.".into());
	}
	validate_ops(ops)?;

	let is_gif = format == "gif";
	// Re-probe audio so the command is self-contained. If the probe fails,
	// assume audio is present: passing an audio codec for a stream that turns
	// out not to exist is a harmless no-op, whereas `-an` would silently drop
	// real audio.
	let has_audio = probe_video(path).map(|i| i.has_audio).unwrap_or(true);
	let output_args = build_output_args(format, has_audio)?;

	let base_chain = build_filterchain(ops);
	let vf = if is_gif {
		Some(wrap_gif(&base_chain))
	} else {
		// libx264/x265/vp9 + yuv420p require even dimensions; crop/scale/
		// transpose can produce odd ones. The trailing guard is a no-op when
		// dimensions are already even.
		let guard = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
		Some(if base_chain.is_empty() {
			guard.to_string()
		} else {
			format!("{base_chain},{guard}")
		})
	};

	let (ss, t) = build_trim_args(ops)?;

	// Write to a sibling temp file, then rename over the destination on
	// success: ffmpeg can't safely read and write the same file in place, and
	// this keeps a half-written file from ever appearing at `output_path`
	// (where the watcher/indexer would pick it up).
	let tmp = temp_sibling(output_path);

	let mut cmd = Command::new("ffmpeg");
	cmd.arg("-y").args(["-loglevel", "error"]);
	if let Some(ss) = ss {
		// `-ss` before `-i` = fast (keyframe) seek; exact because we re-encode.
		cmd.arg("-ss").arg(fmt_num(ss));
	}
	cmd.arg("-i").arg(path);
	if let Some(t) = t {
		// `-t` (output duration) cuts every stream — video and audio — to match.
		cmd.arg("-t").arg(fmt_num(t));
	}
	if let Some(vf) = &vf {
		cmd.arg("-vf").arg(vf);
	}
	cmd.args(&output_args);
	cmd.arg(&tmp);

	let _permit = ffmpeg_slot();
	let out = cmd
		.output()
		.map_err(|e| format!("Failed to run ffmpeg: {e}"))?;
	if !out.status.success() {
		let _ = std::fs::remove_file(&tmp);
		return Err(ffmpeg_error("ffmpeg transcode failed", &out));
	}
	std::fs::rename(&tmp, output_path).map_err(|e| {
		let _ = std::fs::remove_file(&tmp);
		format!("Failed to write {output_path}: {e}")
	})?;
	Ok(())
}

/// A sibling temp path next to `output_path` that keeps the destination's
/// extension (so ffmpeg infers the right muxer) but a unique stem.
fn temp_sibling(output_path: &str) -> PathBuf {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let n = COUNTER.fetch_add(1, Ordering::Relaxed);
	let p = PathBuf::from(output_path);
	let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("tmp");
	let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("garnet");
	let dir = p.parent().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
	dir.join(format!(".{stem}.garnet-tmp-{n}.{ext}"))
}

// --------------------------------------------------------------------------
// Pure builders (unit-tested without ffmpeg)
// --------------------------------------------------------------------------

/// Build the comma-joined `-vf` value from the geometry + color ops, in a
/// fixed order (geometry before color): crop → scale → rotate → color, where
/// color is the W3C-matching RGB chain (see `build_color_filters`). Returns an
/// empty string when no filter-producing op is present. Excludes the
/// even-dimension guard and the GIF palette wrapper (the commit adds those per
/// output format).
fn build_filterchain(ops: &[VideoOperation]) -> String {
	let mut parts: Vec<String> = Vec::new();

	// Geometry in a fixed canonical order — crop → scale → rotate — regardless
	// of the order the ops arrive in, so the saved file matches how the
	// client-side `EditorCanvas` preview composes them (crop region, then scale
	// to output size, then rotate). Last op of each kind wins (the editor only
	// keeps one of each).
	let mut crop: Option<String> = None;
	let mut scale: Option<String> = None;
	let mut rotate: Option<String> = None;
	for op in ops {
		match op {
			// ffmpeg crop arg order is w:h:x:y; our enum is x,y,w,h.
			VideoOperation::Crop { x, y, w, h } => crop = Some(format!("crop={w}:{h}:{x}:{y}")),
			VideoOperation::Resize { w, h } => scale = Some(format!("scale={w}:{h}")),
			VideoOperation::Rotate { angle } => rotate = rotate_filter(*angle),
			_ => {}
		}
	}
	parts.extend(crop);
	parts.extend(scale);
	parts.extend(rotate);

	// Color, AFTER geometry. We replicate the CSS/W3C Filter Effects math in
	// RGB so the saved file matches the editor's live CSS-filter preview.
	//
	// Why NOT ffmpeg's `eq`: `eq`'s brightness is *additive* (CSS brightness
	// multiplies), its operations run in YUV (CSS is sRGB RGB), and the YUV
	// round-trip tints neutral grays. Measured: a gray midtone the preview puts
	// at ~157 came out ~177 with a green cast. Replicating W3C in RGB lands on
	// ~157 with neutrals preserved. (Same lesson the image editor's adjust.rs
	// learned: match the exact CSS-filter math or preview and output drift.)
	parts.extend(build_color_filters(ops));

	parts.join(",")
}

/// The W3C color pipeline as ffmpeg filters (or empty when identity), in the
/// CSS order brightness → contrast → saturate → hue:
///   - brightness(b) then contrast(c) fold to one per-channel affine
///     `out = val*(b*c) + 127.5*(1-c)`, applied via `lutrgb`.
///   - saturate(s) then hue(h) are linear 3×3 RGB matrices; we premultiply
///     them (hue·sat) into one `colorchannelmixer`.
///
/// All in `gbrp` (full-range planar RGB) so the math matches CSS's sRGB space.
fn build_color_filters(ops: &[VideoOperation]) -> Vec<String> {
	let mut b = 1.0f64; // brightness multiplier (1 = identity)
	let mut c = 1.0f64; // contrast (1 = identity)
	let mut s = 1.0f64; // saturation (1 = identity)
	let mut h = 0.0f64; // hue rotation, degrees
	for op in ops {
		match op {
			VideoOperation::AdjustBrightness { offset } => b = 1.0 + offset,
			VideoOperation::AdjustContrast { amount } => c = 1.0 + amount,
			VideoOperation::AdjustSaturation { offset } => s = 1.0 + offset,
			VideoOperation::AdjustHue { offset } => h = *offset,
			_ => {}
		}
	}

	let k = b * c; // combined brightness×contrast gain
	let m = 127.5 * (1.0 - c); // contrast pivot offset (in 0..255 space)
	let affine = (k - 1.0).abs() > 1e-9 || m.abs() > 1e-9;
	let matrix = (s - 1.0).abs() > 1e-9 || h.abs() > 1e-9;
	if !affine && !matrix {
		return Vec::new();
	}

	let mut out = vec!["format=gbrp".to_string()];
	if affine {
		let e = format!("clip(val*{k:.6}{m:+.6},0,255)");
		out.push(format!("lutrgb=r='{e}':g='{e}':b='{e}'"));
	}
	if matrix {
		// Apply saturate first, then hue: combined = hue · saturate.
		let mat = mat3_mul(&hue_matrix(h), &saturate_matrix(s));
		out.push(colorchannelmixer(&mat));
	}
	out
}

type Mat3 = [[f64; 3]; 3];

/// W3C `saturate(s)` matrix (sRGB luma coefficients 0.213/0.715/0.072).
fn saturate_matrix(s: f64) -> Mat3 {
	[
		[0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
		[0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
		[0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
	]
}

/// W3C `hue-rotate(deg)` matrix.
fn hue_matrix(deg: f64) -> Mat3 {
	let (sin, cos) = deg.to_radians().sin_cos();
	[
		[
			0.213 + cos * 0.787 - sin * 0.213,
			0.715 - cos * 0.715 - sin * 0.715,
			0.072 - cos * 0.072 + sin * 0.928,
		],
		[
			0.213 - cos * 0.213 + sin * 0.143,
			0.715 + cos * 0.285 + sin * 0.140,
			0.072 - cos * 0.072 - sin * 0.283,
		],
		[
			0.213 - cos * 0.213 - sin * 0.787,
			0.715 - cos * 0.715 + sin * 0.715,
			0.072 + cos * 0.928 + sin * 0.072,
		],
	]
}

fn mat3_mul(a: &Mat3, b: &Mat3) -> Mat3 {
	let mut o = [[0.0; 3]; 3];
	for (i, row) in o.iter_mut().enumerate() {
		for (j, cell) in row.iter_mut().enumerate() {
			*cell = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
		}
	}
	o
}

/// Emit an ffmpeg `colorchannelmixer` for a 3×3 RGB matrix (no alpha mixing).
fn colorchannelmixer(m: &Mat3) -> String {
	format!(
		"colorchannelmixer=rr={:.6}:rg={:.6}:rb={:.6}:gr={:.6}:gg={:.6}:gb={:.6}:br={:.6}:bg={:.6}:bb={:.6}",
		m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]
	)
}

/// The transpose filter for a clockwise rotation, or `None` for a 0° (or
/// invalid) angle. Validation of the angle happens in `validate_ops`.
fn rotate_filter(angle: i32) -> Option<String> {
	match normalize_rotation(angle).unwrap_or(0) {
		90 => Some("transpose=1".to_string()),        // 90° clockwise
		180 => Some("transpose=1,transpose=1".to_string()),
		270 => Some("transpose=2".to_string()),       // 90° counter-clockwise
		_ => None,
	}
}

/// Normalize a clockwise rotation to one of {0, 90, 180, 270}. Errors on a
/// non-90° multiple (the editor only offers 90° steps).
fn normalize_rotation(angle: i32) -> Result<u32, String> {
	if angle % 90 != 0 {
		return Err(format!("rotation must be a multiple of 90°, got {angle}"));
	}
	Ok((angle.rem_euclid(360)) as u32)
}

/// Wrap a base filterchain in the GIF palette graph (single-input → single
/// output, so it's valid as a `-vf` value). A high-quality palette beats the
/// default 256-color quantization gif would otherwise produce.
fn wrap_gif(base_chain: &str) -> String {
	let palette = "split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5";
	if base_chain.is_empty() {
		palette.to_string()
	} else {
		format!("{base_chain},{palette}")
	}
}

/// Map an export-format string to the ffmpeg codec / container / audio args
/// (NOT the filterchain, input, or output path). Format strings mirror the
/// image editor's `EXPORT_FORMATS` value convention (short, lowercase).
fn build_output_args(format: &str, has_audio: bool) -> Result<Vec<String>, String> {
	let s = |v: &str| v.to_string();
	// Audio codec for a container, or `-an` when there's no audio to carry.
	let audio = |codec: &str| -> Vec<String> {
		if has_audio {
			vec![s("-c:a"), s(codec)]
		} else {
			vec![s("-an")]
		}
	};
	let mut args: Vec<String> = match format {
		"mp4_h264" => vec![
			s("-c:v"), s("libx264"),
			s("-pix_fmt"), s("yuv420p"),
			s("-movflags"), s("+faststart"),
		],
		"mov_h264" => vec![
			s("-c:v"), s("libx264"),
			s("-pix_fmt"), s("yuv420p"),
			s("-movflags"), s("+faststart"),
		],
		"webm_vp9" => vec![s("-c:v"), s("libvpx-vp9"), s("-pix_fmt"), s("yuv420p")],
		"mp4_h265" => vec![
			s("-c:v"), s("libx265"),
			s("-pix_fmt"), s("yuv420p"),
			s("-movflags"), s("+faststart"),
			s("-tag:v"), s("hvc1"),
		],
		"gif" => return Ok(vec![s("-an")]),
		other => return Err(format!("unknown video export format: {other}")),
	};
	let audio_codec = if format == "webm_vp9" { "libopus" } else { "aac" };
	args.extend(audio(audio_codec));
	Ok(args)
}

/// Resolve the trim op into `(start_ss, duration_t)` for `-ss` / `-t`.
/// `-ss` is omitted for a start of 0 (no seek needed). Validation lives in
/// `validate_ops`; this assumes the ops already passed it.
fn build_trim_args(ops: &[VideoOperation]) -> Result<(Option<f64>, Option<f64>), String> {
	for op in ops {
		if let VideoOperation::Trim { start_secs, end_secs } = op {
			let ss = if *start_secs > 0.0 { Some(*start_secs) } else { None };
			return Ok((ss, Some(end_secs - start_secs)));
		}
	}
	Ok((None, None))
}

/// Reject malformed ops before spawning ffmpeg, so the user gets a clean
/// message instead of a cryptic ffmpeg error (or a silently wrong output).
fn validate_ops(ops: &[VideoOperation]) -> Result<(), String> {
	for op in ops {
		match op {
			VideoOperation::Trim { start_secs, end_secs } => {
				if !start_secs.is_finite() || !end_secs.is_finite() || *start_secs < 0.0 {
					return Err("invalid trim range".into());
				}
				if end_secs <= start_secs {
					return Err("trim end must be greater than start".into());
				}
			}
			VideoOperation::Crop { w, h, .. } => {
				if *w == 0 || *h == 0 {
					return Err("crop width and height must be greater than 0".into());
				}
			}
			VideoOperation::Resize { w, h } => {
				if *w == 0 || *h == 0 {
					return Err("resize width and height must be greater than 0".into());
				}
			}
			VideoOperation::Rotate { angle } => {
				normalize_rotation(*angle)?;
			}
			_ => {}
		}
	}
	Ok(())
}

/// Format a float for an ffmpeg arg: up to 4 decimals, trailing zeros (and a
/// trailing dot) trimmed, so `1.5000` → `1.5`, `30.0000` → `30`, `0.0` → `0`.
/// Rust formats f64 with a `.` separator regardless of locale, which is what
/// ffmpeg requires.
fn fmt_num(x: f64) -> String {
	let s = format!("{x:.4}");
	let s = s.trim_end_matches('0').trim_end_matches('.');
	if s.is_empty() || s == "-" {
		"0".to_string()
	} else {
		s.to_string()
	}
}

/// Build a useful one-line-ish error from a failed subprocess: exit code plus
/// the last few non-empty stderr lines (where ffmpeg's actual complaint lives,
/// e.g. "Unknown encoder 'libx264'").
fn ffmpeg_error(context: &str, out: &Output) -> String {
	let stderr = String::from_utf8_lossy(&out.stderr);
	let mut tail: Vec<&str> = stderr
		.lines()
		.filter(|l| !l.trim().is_empty())
		.rev()
		.take(4)
		.collect();
	tail.reverse();
	let code = out.status.code().unwrap_or(-1);
	if tail.is_empty() {
		format!("{context} (exit {code})")
	} else {
		format!("{context} (exit {code}):\n{}", tail.join("\n"))
	}
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn fps_parsing() {
		assert!((parse_fps("30000/1001") - 29.97).abs() < 0.01);
		assert_eq!(parse_fps("30/1"), 30.0);
		assert_eq!(parse_fps("25"), 25.0);
		assert_eq!(parse_fps("0/0"), 0.0);
		assert_eq!(parse_fps("N/A"), 0.0);
		assert_eq!(parse_fps(""), 0.0);
	}

	#[test]
	fn fmt_num_trims() {
		assert_eq!(fmt_num(1.5), "1.5");
		assert_eq!(fmt_num(30.0), "30");
		assert_eq!(fmt_num(0.0), "0");
		assert_eq!(fmt_num(-1.0), "-1");
		assert_eq!(fmt_num(0.123456), "0.1235");
	}

	#[test]
	fn empty_chain() {
		assert_eq!(build_filterchain(&[]), "");
	}

	#[test]
	fn crop_filter_arg_order() {
		// enum is x,y,w,h; ffmpeg wants w:h:x:y.
		let c = build_filterchain(&[VideoOperation::Crop { x: 10, y: 20, w: 100, h: 50 }]);
		assert_eq!(c, "crop=100:50:10:20");
	}

	#[test]
	fn resize_filter() {
		assert_eq!(
			build_filterchain(&[VideoOperation::Resize { w: 640, h: 360 }]),
			"scale=640:360"
		);
	}

	#[test]
	fn rotate_filters() {
		assert_eq!(build_filterchain(&[VideoOperation::Rotate { angle: 90 }]), "transpose=1");
		assert_eq!(
			build_filterchain(&[VideoOperation::Rotate { angle: 180 }]),
			"transpose=1,transpose=1"
		);
		assert_eq!(build_filterchain(&[VideoOperation::Rotate { angle: 270 }]), "transpose=2");
		assert_eq!(build_filterchain(&[VideoOperation::Rotate { angle: 0 }]), "");
		assert_eq!(build_filterchain(&[VideoOperation::Rotate { angle: -90 }]), "transpose=2");
	}

	#[test]
	fn color_uses_w3c_rgb_chain() {
		// brightness 0.2, contrast 0.5 → b=1.2, c=1.5 → k=1.8, m=127.5*(1-1.5)=-63.75.
		// saturation -1.0 → s=0 (full grayscale) → colorchannelmixer present.
		let c = build_filterchain(&[
			VideoOperation::AdjustBrightness { offset: 0.2 },
			VideoOperation::AdjustContrast { amount: 0.5 },
			VideoOperation::AdjustSaturation { offset: -1.0 },
		]);
		assert!(c.starts_with("format=gbrp,"), "got {c}");
		assert!(
			c.contains("lutrgb=r='clip(val*1.800000-63.750000,0,255)'"),
			"got {c}"
		);
		assert!(c.contains("colorchannelmixer=rr="), "got {c}");
		// No additive `eq` brightness anywhere.
		assert!(!c.contains("eq="), "got {c}");
	}

	#[test]
	fn brightness_only_is_pure_multiply() {
		// brightness 0.5 → b=1.5, c=1 → k=1.5, m=0; no contrast pivot, no matrix.
		let c = build_filterchain(&[VideoOperation::AdjustBrightness { offset: 0.5 }]);
		assert_eq!(
			c,
			"format=gbrp,lutrgb=r='clip(val*1.500000+0.000000,0,255)':g='clip(val*1.500000+0.000000,0,255)':b='clip(val*1.500000+0.000000,0,255)'"
		);
	}

	#[test]
	fn hue_only_is_a_matrix() {
		let c = build_filterchain(&[VideoOperation::AdjustHue { offset: 30.0 }]);
		assert!(c.starts_with("format=gbrp,colorchannelmixer=rr="), "got {c}");
		assert!(!c.contains("lutrgb"), "got {c}"); // no affine when b=c=1
	}

	#[test]
	fn no_color_ops_emit_no_color_filters() {
		assert_eq!(build_filterchain(&[VideoOperation::Resize { w: 4, h: 4 }]), "scale=4:4");
	}

	#[test]
	fn full_chain_orders_geometry_before_color() {
		let c = build_filterchain(&[
			VideoOperation::AdjustHue { offset: 15.0 },
			VideoOperation::Crop { x: 0, y: 0, w: 200, h: 100 },
			VideoOperation::AdjustBrightness { offset: 0.1 },
			VideoOperation::Rotate { angle: 90 },
			VideoOperation::Resize { w: 100, h: 50 },
		]);
		// Geometry first (crop → scale → rotate), then the RGB color chain.
		assert!(
			c.starts_with("crop=200:100:0:0,scale=100:50,transpose=1,format=gbrp,"),
			"got {c}"
		);
		assert!(c.contains("lutrgb=") && c.contains("colorchannelmixer="), "got {c}");
	}

	#[test]
	fn saturate_matrix_preserves_neutral() {
		// Rows of the saturate matrix sum to 1, so gray stays gray for any s.
		for s in [0.0, 0.5, 1.0, 2.0] {
			let m = saturate_matrix(s);
			for row in &m {
				assert!((row.iter().sum::<f64>() - 1.0).abs() < 1e-9);
			}
		}
	}

	#[test]
	fn output_args_mp4_h264() {
		let a = build_output_args("mp4_h264", true).unwrap();
		assert!(a.windows(2).any(|w| w == ["-c:v", "libx264"]));
		assert!(a.windows(2).any(|w| w == ["-pix_fmt", "yuv420p"]));
		assert!(a.windows(2).any(|w| w == ["-movflags", "+faststart"]));
		assert!(a.windows(2).any(|w| w == ["-c:a", "aac"]));
	}

	#[test]
	fn output_args_no_audio_uses_an() {
		let a = build_output_args("mp4_h264", false).unwrap();
		assert!(a.iter().any(|x| x == "-an"));
		assert!(!a.iter().any(|x| x == "aac"));
	}

	#[test]
	fn output_args_webm_uses_vp9_opus_no_faststart() {
		let a = build_output_args("webm_vp9", true).unwrap();
		assert!(a.windows(2).any(|w| w == ["-c:v", "libvpx-vp9"]));
		assert!(a.windows(2).any(|w| w == ["-c:a", "libopus"]));
		assert!(!a.iter().any(|x| x == "+faststart"));
	}

	#[test]
	fn output_args_gif_drops_audio() {
		let a = build_output_args("gif", true).unwrap();
		assert_eq!(a, vec!["-an"]);
	}

	#[test]
	fn output_args_unknown_errors() {
		assert!(build_output_args("avi_mjpeg", true).is_err());
	}

	#[test]
	fn rotation_normalization() {
		assert_eq!(normalize_rotation(90).unwrap(), 90);
		assert_eq!(normalize_rotation(450).unwrap(), 90);
		assert_eq!(normalize_rotation(-90).unwrap(), 270);
		assert_eq!(normalize_rotation(0).unwrap(), 0);
		assert!(normalize_rotation(45).is_err());
	}

	#[test]
	fn trim_args_and_validation() {
		let ops = [VideoOperation::Trim { start_secs: 2.0, end_secs: 5.0 }];
		assert!(validate_ops(&ops).is_ok());
		let (ss, t) = build_trim_args(&ops).unwrap();
		assert_eq!(ss, Some(2.0));
		assert_eq!(t, Some(3.0));

		// start of 0 omits -ss.
		let ops0 = [VideoOperation::Trim { start_secs: 0.0, end_secs: 4.0 }];
		assert_eq!(build_trim_args(&ops0).unwrap(), (None, Some(4.0)));

		// end <= start is rejected.
		let bad = [VideoOperation::Trim { start_secs: 5.0, end_secs: 5.0 }];
		assert!(validate_ops(&bad).is_err());
	}

	#[test]
	fn validation_rejects_zero_crop() {
		assert!(validate_ops(&[VideoOperation::Crop { x: 0, y: 0, w: 0, h: 10 }]).is_err());
	}

	#[test]
	fn gif_wrap() {
		assert!(wrap_gif("").starts_with("split"));
		assert!(wrap_gif("scale=100:100").starts_with("scale=100:100,split"));
	}

	#[test]
	fn operation_json_roundtrip() {
		let ops = vec![
			VideoOperation::Trim { start_secs: 1.0, end_secs: 2.0 },
			VideoOperation::AdjustBrightness { offset: 0.3 },
			VideoOperation::Rotate { angle: 90 },
		];
		let json = serde_json::to_string(&ops).unwrap();
		assert!(json.contains("\"type\":\"trim\""));
		assert!(json.contains("\"type\":\"adjust_brightness\""));
		assert!(json.contains("\"type\":\"rotate\""));
		let decoded: Vec<VideoOperation> = serde_json::from_str(&json).unwrap();
		assert_eq!(decoded.len(), 3);
	}

	#[test]
	fn parse_probe_json_basic() {
		let v: serde_json::Value = serde_json::from_str(
			r#"{
				"format": { "duration": "12.500000" },
				"streams": [
					{ "codec_type": "video", "width": 1920, "height": 1080,
					  "codec_name": "h264", "r_frame_rate": "30000/1001" },
					{ "codec_type": "audio", "codec_name": "aac" }
				]
			}"#,
		)
		.unwrap();
		let info = parse_probe_json(&v).unwrap();
		assert_eq!(info.width, 1920);
		assert_eq!(info.height, 1080);
		assert_eq!(info.codec, "h264");
		assert!(info.has_audio);
		assert!((info.duration_secs - 12.5).abs() < 1e-6);
		assert!((info.fps - 29.97).abs() < 0.01);
	}

	#[test]
	fn parse_probe_json_no_video_errors() {
		let v: serde_json::Value =
			serde_json::from_str(r#"{ "streams": [ { "codec_type": "audio" } ] }"#).unwrap();
		assert!(parse_probe_json(&v).is_err());
	}
}

/// ffmpeg-gated integration test (synthesizes a clip, round-trips the
/// commands). Ignored by default — run with:
///   cargo test -p garnet --release video_roundtrip -- --ignored --nocapture
#[cfg(test)]
mod integration {
	use super::*;

	#[test]
	#[ignore]
	fn video_roundtrip() {
		if !ffmpeg_available() {
			println!("[video_roundtrip] ffmpeg not on PATH; skipping");
			return;
		}
		let dir = std::env::temp_dir();
		let src = dir.join("garnet-test-src.mp4");
		// 2s, 64x64, 10fps test pattern with a tone (so it has an audio stream).
		let gen = Command::new("ffmpeg")
			.args([
				"-y", "-loglevel", "error",
				"-f", "lavfi", "-i", "testsrc=duration=2:size=64x64:rate=10",
				"-f", "lavfi", "-i", "sine=frequency=440:duration=2",
				"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
				"-shortest",
			])
			.arg(&src)
			.output()
			.unwrap();
		assert!(gen.status.success(), "gen failed: {}", String::from_utf8_lossy(&gen.stderr));

		// Probe.
		let info = probe_video(src.to_str().unwrap()).unwrap();
		assert_eq!((info.width, info.height), (64, 64));
		assert!(info.has_audio);
		assert!((info.duration_secs - 2.0).abs() < 0.3);

		// Frame.
		let frame = extract_frame(src.to_str().unwrap(), 1.0, Some(48)).unwrap();
		assert!(std::path::Path::new(&frame).exists());

		// Commit: trim + crop + color, export mp4_h264. The color ops exercise
		// the W3C RGB chain (format=gbrp + lutrgb + colorchannelmixer) end-to-end.
		let out = dir.join("garnet-test-out.mp4");
		let ops = vec![
			VideoOperation::Trim { start_secs: 0.5, end_secs: 1.5 },
			VideoOperation::Crop { x: 1, y: 1, w: 33, h: 33 }, // odd dims → guard kicks in
			VideoOperation::AdjustBrightness { offset: 0.2 },
			VideoOperation::AdjustContrast { amount: 0.1 },
			VideoOperation::AdjustSaturation { offset: -0.3 },
			VideoOperation::AdjustHue { offset: 20.0 },
		];
		commit(src.to_str().unwrap(), &ops, out.to_str().unwrap(), "mp4_h264").unwrap();
		let out_info = probe_video(out.to_str().unwrap()).unwrap();
		assert!((out_info.duration_secs - 1.0).abs() < 0.3, "duration was {}", out_info.duration_secs);
		assert_eq!(out_info.width % 2, 0, "width must be even");
		assert_eq!(out_info.height % 2, 0, "height must be even");

		let _ = std::fs::remove_file(&src);
		let _ = std::fs::remove_file(&out);
		let _ = std::fs::remove_file(&frame);
	}
}
