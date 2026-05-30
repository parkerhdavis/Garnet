// SPDX-License-Identifier: AGPL-3.0-or-later
//! Helpers for the general workspace `config` fields. Two are cross-cutting
//! (available to any workflow that opts in via `usesWorkingFolder`):
//!   - `rootFolder` — a root OS directory the workflow's file tools draw from.
//!   - `fileFilters` — a comma/space-separated extension list scoping which
//!     files show in the working-folder browser (empty = all supported images).
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
export function getWorkflowConfig(ws: Workspace, key: string): Record<string, unknown> {
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
