// SPDX-License-Identifier: AGPL-3.0-or-later
//! Stub destinations for sidebar routes whose functionality is deferred to
//! a later phase. Each one renders a centered title + description + icon so
//! the navigation shell feels real while the underlying behavior is built.

import { useParams } from "react-router-dom";
import {
	HiBolt,
	HiCog6Tooth,
	HiCube,
	HiFilm,
	HiFolder,
	HiInformationCircle,
	HiMusicalNote,
	HiPhoto,
	HiPuzzlePiece,
	HiSparkles,
	HiSquares2X2,
	HiSwatch,
} from "react-icons/hi2";
import { StubPage } from "@/pages/StubPage";

export function WorkspacesPage() {
	return (
		<StubPage
			title="Workspaces"
			icon={HiSquares2X2}
			description="User-defined collections that combine manually-added assets with filter-rule
                automatic membership (e.g., 'every video in this folder')."
		/>
	);
}

const TYPE_META: Record<
	string,
	{ title: string; icon: typeof HiPhoto; description: string }
> = {
	images: {
		title: "Images",
		icon: HiPhoto,
		description: "Raster + vector image formats in the library.",
	},
	videos: {
		title: "Videos",
		icon: HiFilm,
		description: "Video files across all sources.",
	},
	animations: {
		title: "Animations",
		icon: HiSparkles,
		description: "Animated formats — GIFs, animated WebP, sprite sheets, and similar.",
	},
	audio: {
		title: "Audio",
		icon: HiMusicalNote,
		description: "Audio files across all sources.",
	},
	models: {
		title: "Models",
		icon: HiCube,
		description: "3D mesh and scene formats across all sources.",
	},
};

export function TypePage() {
	const { kind } = useParams<{ kind: string }>();
	const meta = TYPE_META[kind ?? ""] ?? {
		title: "Unknown type",
		icon: HiSquares2X2,
		description: undefined,
	};
	return <StubPage title={meta.title} icon={meta.icon} description={meta.description} />;
}

export function ModulesPage() {
	return (
		<StubPage
			title="Modules"
			icon={HiPuzzlePiece}
			description="Install, configure, and remove first-party modules. The module API is a
                Phase 2 deliverable; today this is a manager shell awaiting the loader."
		/>
	);
}

export function AutomationsPage() {
	return (
		<StubPage
			title="Automations"
			icon={HiBolt}
			description="Saved sequences of operations the user can name and reuse. Phase 2."
		/>
	);
}

export function SourcesIndexPage() {
	return (
		<StubPage
			title="Sources"
			icon={HiFolder}
			description="Pinned source folders for quick navigation. Pin a library root from
                Settings → Library Roots to surface it here."
		/>
	);
}

export function SettingsAppearancePage() {
	return (
		<StubPage
			title="Appearance"
			icon={HiSwatch}
			description="Theme, accent color, grid density, and font size. Phase 2."
		/>
	);
}

export function SettingsGeneralPage() {
	return (
		<StubPage
			title="General"
			icon={HiCog6Tooth}
			description="Startup behavior, thumbnail cache controls, and other preferences."
		/>
	);
}

export function SettingsAboutPage() {
	return (
		<StubPage
			title={`Garnet v${__APP_VERSION__}`}
			icon={HiInformationCircle}
			description="A free, open-source digital asset manager with pluggable per-format
                modules. Developed by Parker H. Davis under PhD LLC. AGPL-3.0-or-later."
		/>
	);
}
