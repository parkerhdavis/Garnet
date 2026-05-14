// SPDX-License-Identifier: AGPL-3.0-or-later
//! Left navigation. Groups the app's pages into five sections:
//!
//! - **Workspaces** — user-defined collections (manual + filter-rule based).
//!   V1 ships with the section structure + a "new workspace" affordance;
//!   functionality lands in a later phase.
//! - **Types** — one page per media category (Images, Videos, Animations,
//!   Audio, Models). Each will land as a pre-filtered Library view; V1 stubs
//!   the destination.
//! - **Sources** — pinned source folders. V1 ships the section + a "pin
//!   source" affordance; the pinning model itself comes later.
//! - **Functions** — Modules manager + Automations.
//! - **Settings** — split into subsections (Library Roots, Appearance,
//!   About). The existing roots-management UX lives under Library Roots.
//!
//! Clicking the Garnet logo/title returns to the all-assets root view.

import { NavLink, Link } from "react-router-dom";
import type { IconType } from "react-icons";
import {
	HiBolt,
	HiCog6Tooth,
	HiCube,
	HiFilm,
	HiFolder,
	HiFolderPlus,
	HiInformationCircle,
	HiMusicalNote,
	HiPhoto,
	HiPlus,
	HiPuzzlePiece,
	HiSparkles,
	HiSquares2X2,
	HiSwatch,
} from "react-icons/hi2";

export function Sidebar() {
	return (
		<aside className="w-60 shrink-0 bg-base-100 border-r border-base-300 flex flex-col">
			<Link
				to="/"
				className="px-4 py-3.5 border-b border-base-300 flex items-center gap-2.5 hover:bg-base-200/60 transition-colors"
				title="Garnet — all assets"
			>
				<img
					src="/garnet-icon.png"
					alt=""
					className="size-7 rounded-md select-none"
					draggable={false}
				/>
				<div className="min-w-0">
					<div className="text-base font-semibold tracking-tight leading-none">
						Garnet
					</div>
					<div className="text-[10px] text-base-content/60 mt-1">
						v{__APP_VERSION__}
					</div>
				</div>
			</Link>

			<nav className="flex-1 overflow-y-auto py-3 px-2 space-y-4">
				<NavSection title="Workspaces">
					<NavAction icon={HiPlus} disabled>
						New workspace
					</NavAction>
				</NavSection>

				<NavSection title="Types">
					<NavItem to="/types/images" icon={HiPhoto}>Images</NavItem>
					<NavItem to="/types/videos" icon={HiFilm}>Videos</NavItem>
					<NavItem to="/types/animations" icon={HiSparkles}>
						Animations
					</NavItem>
					<NavItem to="/types/audio" icon={HiMusicalNote}>Audio</NavItem>
					<NavItem to="/types/models" icon={HiCube}>Models</NavItem>
				</NavSection>

				<NavSection title="Sources">
					<NavAction icon={HiFolderPlus} disabled>
						Pin source
					</NavAction>
				</NavSection>

				<NavSection title="Functions">
					<NavItem to="/functions/modules" icon={HiPuzzlePiece}>
						Modules
					</NavItem>
					<NavItem to="/functions/automations" icon={HiBolt}>
						Automations
					</NavItem>
				</NavSection>

				<NavSection title="Settings">
					<NavItem to="/settings/library" icon={HiFolder}>
						Library Roots
					</NavItem>
					<NavItem to="/settings/appearance" icon={HiSwatch}>
						Appearance
					</NavItem>
					<NavItem to="/settings/general" icon={HiCog6Tooth}>
						General
					</NavItem>
					<NavItem to="/settings/about" icon={HiInformationCircle}>
						About
					</NavItem>
				</NavSection>
			</nav>

			<footer className="p-3 text-[10px] text-base-content/40 border-t border-base-300 flex items-center justify-between">
				<span>Phase 1 — base toolkit</span>
				<HiSquares2X2 className="size-3 opacity-60" />
			</footer>
		</aside>
	);
}

function NavSection({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div>
			<div className="text-[10px] uppercase tracking-wider text-base-content/40 px-2 mb-1.5 font-semibold">
				{title}
			</div>
			<ul className="flex flex-col gap-0.5">{children}</ul>
		</div>
	);
}

function NavItem({
	to,
	icon: Icon,
	children,
}: {
	to: string;
	icon: IconType;
	children: React.ReactNode;
}) {
	return (
		<li>
			<NavLink
				to={to}
				className={({ isActive }) =>
					`flex items-center gap-2 px-2 py-1.5 rounded transition-colors ${
						isActive
							? "bg-primary/15 text-primary"
							: "text-base-content/80 hover:bg-base-200 hover:text-base-content"
					}`
				}
			>
				<Icon className="size-4 shrink-0" />
				<span className="truncate">{children}</span>
			</NavLink>
		</li>
	);
}

function NavAction({
	icon: Icon,
	children,
	onClick,
	disabled,
}: {
	icon: IconType;
	children: React.ReactNode;
	onClick?: () => void;
	disabled?: boolean;
}) {
	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				disabled={disabled}
				className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-base-content/55 hover:bg-base-200 hover:text-base-content/85 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
			>
				<Icon className="size-3.5 shrink-0" />
				<span className="truncate">{children}</span>
			</button>
		</li>
	);
}
