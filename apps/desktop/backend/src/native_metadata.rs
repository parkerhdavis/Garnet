// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-side access to the `asset_metadata` table — format-extracted "native"
//! metadata produced by the indexer (image dimensions, EXIF, ID3, etc.). The
//! complementary user-editable store lives in `garnet_metadata`.

use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AssetMetadata {
	pub key: String,
	pub value: String,
}

fn stringify<E: std::fmt::Display>(e: E) -> String {
	e.to_string()
}

#[tauri::command]
pub fn list_asset_metadata(
	state: State<AppState>,
	asset_id: i64,
) -> Result<Vec<AssetMetadata>, String> {
	let conn = state.db.lock().map_err(stringify)?;
	let mut stmt = conn
		.prepare(
			"SELECT key, value FROM asset_metadata WHERE asset_id = ?1
			 ORDER BY key ASC",
		)
		.map_err(stringify)?;
	let rows = stmt
		.query_map([asset_id], |r| {
			Ok(AssetMetadata {
				key: r.get(0)?,
				value: r.get(1)?,
			})
		})
		.map_err(stringify)?
		.collect::<Result<Vec<_>, _>>()
		.map_err(stringify)?;
	Ok(rows)
}
