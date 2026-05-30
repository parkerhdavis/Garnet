// SPDX-License-Identifier: AGPL-3.0-or-later
//! Helpers for the general workspace `config` fields. Two are cross-cutting and
//! available to **every** workspace type (set in the New Workspace dialog and
//! the Settings dialog):
//!   - `rootFolder` — a root folder. File-tool workflows (3D Texturing) draw
//!     inputs from it; catalog-backed workflows (the base Library view, the
//!     Music Library) scope the library to assets beneath it.
//!   - `fileFilters` — a comma/space-separated extension list. Scopes the
//!     working-folder browser for file-tool workflows, and the catalog query
//!     for catalog-backed ones (empty = all supported types).
//! Workflow-specific keys (e.g. `texturing.outputDir`) are namespaced under the
//! workflow id and read/written by that workflow.

import type { Workspace } from "@/lib/tauri";

export function getWorkingFolder(ws: Workspace): string | null {
	const v = ws.config?.rootFolder;
	return typeof v === "string" && v ? v : null;
}

export function getFileFilters(ws: Workspace): string | null {
	const v = ws.config?.fileFilters;
	return typeof v === "string" && v ? v : null;
}

/// Read a namespaced workflow config object (e.g. config.texturing).
export function getWorkflowConfig(
	ws: Workspace,
	key: string,
): Record<string, unknown> {
	const v = ws.config?.[key];
	return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/// Parse a filter string into a lowercase extension list, or null for "all".
export function parseFileFilters(filters: string | null): string[] | null {
	if (!filters) return null;
	const exts = filters
		.split(/[\s,]+/)
		.map((s) => s.trim().replace(/^\./, "").toLowerCase())
		.filter(Boolean);
	return exts.length > 0 ? exts : null;
}

/// Map a workspace's cross-cutting `rootFolder` + `fileFilters` to catalog-query
/// scope params. `underPath` is an absolute folder (null = whole library);
/// `formats` is the parsed extension allow-list (null = all types). Reused by
/// the base Library workspace view and the Music Library plugin.
export function workspaceScopeQuery(ws: Workspace): {
	underPath: string | null;
	formats: string[] | null;
} {
	return {
		underPath: getWorkingFolder(ws),
		formats: parseFileFilters(getFileFilters(ws)),
	};
}
