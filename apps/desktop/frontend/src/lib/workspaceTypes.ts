// SPDX-License-Identifier: AGPL-3.0-or-later
//! Workspace-type metadata. The base "library" type is defined here; plugin
//! workflow types come from the registry. Used by the sidebar (to render each
//! workspace's icon/label) and the new-workspace dialog (to offer types).

import type { IconType } from "react-icons";
import { HiRectangleStack, HiSquares2X2 } from "react-icons/hi2";
import { allWorkflows } from "@/plugins/registry";
import { enabledWorkflows } from "@/stores/pluginsStore";

/// The base workspace type: a named library view with an optional saved filter.
export const LIBRARY_TYPE = "library";

export type WorkspaceTypeMeta = {
	type: string;
	label: string;
	icon: IconType;
	description: string;
	/// Whether this type exposes a working folder + file filters (see
	/// `WorkflowContribution.usesWorkingFolder`). Universal — true for every
	/// shipped type.
	usesWorkingFolder: boolean;
	/// Default file-filters string pre-filled in the New Workspace dialog.
	defaultFileFilters?: string;
};

export const LIBRARY_TYPE_META: WorkspaceTypeMeta = {
	type: LIBRARY_TYPE,
	label: "Library",
	icon: HiRectangleStack,
	description: "A named library view, optionally scoped to a folder + filters.",
	// The working folder scopes the library view to a subtree; file filters
	// narrow it by type. Both optional — unset means the whole library.
	usesWorkingFolder: true,
};

/// Metadata for any workspace type, resolving even disabled-plugin types so an
/// existing workspace whose plugin was later disabled still renders sensibly.
export function workspaceTypeMeta(type: string): WorkspaceTypeMeta {
	if (type === LIBRARY_TYPE) return LIBRARY_TYPE_META;
	const w = allWorkflows().find((x) => x.contribution.workspaceType === type);
	if (w) {
		return {
			type,
			label: w.contribution.label,
			icon: w.contribution.icon,
			description: w.contribution.description,
			usesWorkingFolder: w.contribution.usesWorkingFolder ?? true,
			defaultFileFilters: w.contribution.defaultFileFilters,
		};
	}
	return {
		type,
		label: type,
		icon: HiSquares2X2,
		description: "",
		usesWorkingFolder: true,
	};
}

/// The workspace types a user can create right now: the base Library type plus
/// every enabled plugin's workflow type. Non-reactive snapshot — callers that
/// must update on plugin-toggle should subscribe to `pluginsStore.enabledIds`.
export function creatableWorkspaceTypes(): WorkspaceTypeMeta[] {
	const pluginTypes = enabledWorkflows().map((w) => ({
		type: w.workspaceType,
		label: w.label,
		icon: w.icon,
		description: w.description,
		usesWorkingFolder: w.usesWorkingFolder ?? true,
		defaultFileFilters: w.defaultFileFilters,
	}));
	return [LIBRARY_TYPE_META, ...pluginTypes];
}
