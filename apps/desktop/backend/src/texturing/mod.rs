// SPDX-License-Identifier: AGPL-3.0-or-later
//! The 3D Texturing plugin's native surface: channel packing/unpacking/
//! swizzling, normal-map operations, and channel-packing presets. Compiled
//! into the Garnet binary (first-party, compiled-in plugin model) and exposed
//! as Tauri commands registered in `main.rs`. The pure normal-map functions
//! are also reused by the Automations module's FlipGreen / Normalize steps.

pub mod channel_pack;
pub mod normal_map;
pub mod presets;

pub use channel_pack::{
	export_packed, export_swizzled, export_unpacked, pack_channels, swizzle_channels,
	unpack_channels,
};
pub use normal_map::{
	blend_normals, export_normal_result, flip_normal_green, height_to_normal, normalize_map,
};
pub use presets::{delete_user_preset, get_builtin_presets, load_user_presets, save_user_preset};
