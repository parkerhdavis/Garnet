// SPDX-License-Identifier: AGPL-3.0-or-later
//! Stub destinations for sidebar routes whose functionality is deferred to
//! a later phase. Each one renders a centered title + description + icon so
//! the navigation shell feels real while the underlying behavior is built.

import {
	HiBolt,
	HiCog6Tooth,
	HiFolder,
	HiInformationCircle,
	HiPuzzlePiece,
	HiSquares2X2,
	HiSwatch,
} from "react-icons/hi2";
import { StubPage } from "@/pages/StubPage";
import { usePrefsStore } from "@/stores/prefsStore";
import type { AnimatedImagesBucket } from "@/lib/typeFilters";

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

export function PluginsPage() {
	return (
		<StubPage
			title="Plugins"
			icon={HiPuzzlePiece}
			description="Install, configure, and remove first-party plugins. The plugin API is a
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
	const bucket = usePrefsStore((s) => s.animatedImagesBucket);
	const setBucket = usePrefsStore((s) => s.setAnimatedImagesBucket);
	const options: { value: AnimatedImagesBucket; label: string; hint: string }[] = [
		{
			value: "images",
			label: "Images",
			hint: "Group GIF, APNG, and animated WebP under the Images type.",
		},
		{
			value: "animations",
			label: "Animations",
			hint: "Group GIF, APNG, and animated WebP under the Animations type.",
		},
	];
	return (
		<div className="flex-1 min-h-0 overflow-auto p-6">
			<div className="max-w-2xl mx-auto">
				<header className="flex items-center gap-3 mb-6">
					<div className="size-10 rounded-lg bg-base-200 flex items-center justify-center">
						<HiCog6Tooth className="size-5 text-base-content/70" />
					</div>
					<div>
						<h1 className="text-xl font-semibold tracking-tight">General</h1>
						<p className="text-sm text-base-content/60">
							Type-categorization preferences and other general settings.
						</p>
					</div>
				</header>

				<section className="card bg-base-100 border border-base-300">
					<div className="card-body gap-3">
						<h2 className="card-title text-base">Animated raster formats</h2>
						<p className="text-sm text-base-content/70">
							GIF, APNG, and animated WebP can reasonably belong to either Images
							or Animations. Pick where they show up in the sidebar.
						</p>
						<div className="flex flex-col gap-2 mt-2">
							{options.map((opt) => (
								<label
									key={opt.value}
									className={`flex items-start gap-3 p-3 rounded border cursor-pointer transition-colors ${
										bucket === opt.value
											? "border-primary bg-primary/5"
											: "border-base-300 hover:bg-base-200"
									}`}
								>
									<input
										type="radio"
										name="animated-images-bucket"
										className="radio radio-sm radio-primary mt-0.5"
										checked={bucket === opt.value}
										onChange={() => setBucket(opt.value)}
									/>
									<div className="min-w-0">
										<div className="font-medium text-sm">{opt.label}</div>
										<div className="text-xs text-base-content/60">{opt.hint}</div>
									</div>
								</label>
							))}
						</div>
					</div>
				</section>
			</div>
		</div>
	);
}

export function SettingsAboutPage() {
	return (
		<StubPage
			title={`Garnet v${__APP_VERSION__}`}
			icon={HiInformationCircle}
			description="A free, open-source digital asset manager with modular per-format
                plugins. Developed by Parker H. Davis under PhD LLC. AGPL-3.0-or-later."
		/>
	);
}
