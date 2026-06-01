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
	/// The working folder + file filters are a universal workspace capability,
	/// shown for every type. Set this `false` only for a hypothetical type that
	/// genuinely shouldn't offer them (none ship today). File-tool workflows (3D
	/// Texturing) draw inputs from the folder; catalog-backed ones (Music
	/// Library) use it to scope the library.
	usesWorkingFolder?: boolean;
	/// Pre-fills the New Workspace dialog's file-filters field when this type is
	/// chosen (the user can still edit/clear it). Music Library sets the audio
	/// extension list so a music workspace defaults to audio-only.
	defaultFileFilters?: string;
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

/// One result a command-palette source can return. The core palette renders it
/// and navigates to `to` when chosen, so plugins stay decoupled from the
/// router.
export interface PaletteItemContribution {
	/// Unique within the contributing source (used for the React key).
	id: string;
	label: string;
	sublabel?: string;
	icon?: IconType;
	/// HashRouter path to navigate to on select (e.g. "/workspaces/3?album=…").
	to: string;
}

/// A command-palette result provider contributed by a plugin (e.g. the Music
/// Library searching albums/artists). The palette calls `search` — debounced,
/// with the user's query — and lists the results under `group`. Return [] when
/// there's nothing to offer (empty query, data unavailable, etc.).
export interface PaletteSourceContribution {
	id: string;
	/// Heading shown above this source's results in the palette.
	group: string;
	search: (query: string) => Promise<PaletteItemContribution[]>;
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
	/// Command-palette result providers, queried when the user types in the
	/// Ctrl+K palette (e.g. the Music Library searching albums/artists).
	paletteSources?: PaletteSourceContribution[];
	/// An always-mounted, app-global component (gated on the plugin being
	/// enabled), rendered by the Layout above the footer regardless of route.
	/// The Music Library uses it for a persistent player that keeps playing
	/// after you leave the music workspace. Render nothing when idle.
	global?: React.ComponentType;
}
