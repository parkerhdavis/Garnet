// SPDX-License-Identifier: AGPL-3.0-or-later
//! Client-side group-key derivation. Mirrors the SQL grouping in
//! `backend/src/assets.rs::group_expr` — when the backend orders assets by a
//! group key, the frontend recomputes that key per asset so it can render a
//! heading wherever the key changes between adjacent rows.

import type { AssetGroupBy } from "@/lib/tauri";
import { abbreviatePath } from "@/lib/paths";

export type GroupOption = {
	value: AssetGroupBy;
	label: string;
};

export const GROUP_OPTIONS: GroupOption[] = [
	{ value: "none", label: "No grouping" },
	{ value: "root", label: "Source" },
	{ value: "folder", label: "Folder" },
	{ value: "format", label: "Format" },
	{ value: "mtime_bucket", label: "Modified date" },
];

const DAY_SECS = 86_400;

/** Bucket boundaries are evaluated relative to the time the key is computed,
 *  which matches how the backend captures NOW when building the query. Small
 *  drift between the two clocks is harmless (the asset stays in the same run
 *  even if its label changes by one). */
export function mtimeBucket(mtime: number | null): { key: number; label: string } {
	if (mtime === null) return { key: 4, label: "Unknown date" };
	const now = Math.floor(Date.now() / 1000);
	if (mtime >= now - DAY_SECS) return { key: 0, label: "Today" };
	if (mtime >= now - 7 * DAY_SECS) return { key: 1, label: "Past week" };
	if (mtime >= now - 30 * DAY_SECS) return { key: 2, label: "Past month" };
	return { key: 3, label: "Older" };
}

function folderOf(rel: string): string {
	const i = rel.lastIndexOf("/");
	return i < 0 ? "" : rel.slice(0, i);
}

/** Derive the (key, label) for a single asset under the given group mode.
 *  `key` is what's compared between rows to detect group boundaries; `label`
 *  is the heading shown to the user. */
export function groupOf(
	asset: { root_path: string; relative_path: string; format: string | null; mtime: number | null },
	groupBy: AssetGroupBy,
): { key: string; label: string } | null {
	switch (groupBy) {
		case "none":
			return null;
		case "root":
			return { key: `r:${asset.root_path}`, label: abbreviatePath(asset.root_path) };
		case "folder": {
			const folder = folderOf(asset.relative_path);
			const slash = folder.lastIndexOf("/");
			const leaf = slash < 0 ? folder : folder.slice(slash + 1);
			return {
				key: `f:${asset.root_path}::${folder}`,
				label: leaf === "" ? `${abbreviatePath(asset.root_path)} (root)` : leaf,
			};
		}
		case "format":
			return {
				key: `t:${asset.format ?? ""}`,
				label: asset.format ?? "(no format)",
			};
		case "mtime_bucket": {
			const b = mtimeBucket(asset.mtime);
			return { key: `m:${b.key}`, label: b.label };
		}
	}
}
