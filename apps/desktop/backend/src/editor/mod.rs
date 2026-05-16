// SPDX-License-Identifier: AGPL-3.0-or-later
//! Image editor module. Each tool is a pure function operating on
//! `image::DynamicImage`; the `pipeline` submodule composes an ordered list
//! of operations and exposes the two Tauri commands the frontend talks to:
//!
//! - `preview_edit` — apply the operation stack to a downscaled copy and
//!   return a base64 PNG, so slider drags stay snappy.
//! - `commit_edit` — apply the stack at full resolution and write to disk.
//!
//! Adjust functions (hue, saturation, luminance curve) were lifted from
//! Packi's `adjust.rs` so improvements stay aligned across both projects.

pub mod adjust;
pub mod io;
pub mod pipeline;
pub mod transform;

pub use pipeline::{commit_edit, preview_edit};
