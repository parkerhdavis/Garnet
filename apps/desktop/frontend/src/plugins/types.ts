// SPDX-License-Identifier: AGPL-3.0-or-later
//! Plugin contribution model. Garnet's first plugin (3D Texturing) is
//! compiled into the binary; the "plugin boundary" is a convention enforced by
//! this registry API and the `src/plugins/<id>/` directory layout, not a
//! runtime sandbox. True dynamic loading (cdylib / sidecar) is deferred and
//! only matters for out-of-scope third-party plugins.
//!
//! A plugin contributes any of:
//!   - **Workflows** — a specialized workspace-interior UI bound to a
//!     workspace type (the user creates a Workspace of that type; the plugin
//!     renders its tools inside).
//!   - **Automation steps** — pipeline steps for the base Automations module.
//!     Base steps (Rename/Resize/Convert) register through the same mechanism
//!     via a built-in `core` pseudo-plugin.

import type { IconType } from "react-icons";
import type { Workspace } from "@/lib/tauri";

/// A workspace-interior UI contributed by a plugin. The `workspaceType` is
/// stored on the `workspaces` row; when the user opens such a workspace, the
/// router renders `Component` with that row.
export interface WorkflowContribution {
	/// Stable id matching `workspaces.type` (e.g. "texturing").
	workspaceType: string;
	/// Shown in the "new workspace" type picker and the workspace header.
	label: string;
	icon: IconType;
	description: string;
	/// Renders the workspace interior. Receives the workspace row so it can
	/// read/write type-specific `config` and (later) scope to library assets.
	Component: React.ComponentType<{ workspace: Workspace }>;
}

/// Editor for one automation step's parameters. Receives the current params
/// object and a setter; renders whatever controls the step needs.
export type AutomationStepParamsEditor = React.ComponentType<{
	params: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
}>;

/// One pipeline step the Automations module can offer. The `type` maps 1:1 to
/// the Rust `BatchStep` serde tag, so the frontend can build the backend
/// payload directly from `{ type, ...params }`.
export interface AutomationStepContribution {
	/// Matches the Rust `BatchStep` serde tag, e.g. "convert" | "flip-green".
	type: string;
	label: string;
	description: string;
	icon: IconType;
	/// Palette section. "base" for core steps; otherwise the contributing
	/// plugin id (used to group + label the palette and to gate visibility).
	group: "base" | string;
	/// Fresh default params for a newly-added instance of this step.
	defaultParams: () => Record<string, unknown>;
	/// Controls for editing this step's params in the pipeline list. Omit for
	/// param-less steps (e.g. flip-green, normalize).
	ParamsEditor?: AutomationStepParamsEditor;
}

/// A first-party plugin compiled into Garnet. Registered at startup via a
/// static-import side effect (see `src/plugins/index.ts`).
export interface GarnetPlugin {
	/// Short id, used as the enable/disable key and palette group (e.g.
	/// "texturing"). Distinct from the manifest `identity`.
	id: string;
	/// Reverse-DNS identity tying this to its repo `manifest.json`, when one
	/// exists (e.g. "com.parkerhdavis.garnet.texturing").
	manifestIdentity?: string;
	name: string;
	description?: string;
	version?: string;
	workflows?: WorkflowContribution[];
	automationSteps?: AutomationStepContribution[];
}
