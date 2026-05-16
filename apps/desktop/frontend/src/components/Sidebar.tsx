// SPDX-License-Identifier: AGPL-3.0-or-later
//! Left navigation. Two-tier hierarchy:
//!
//! - **Workspaces** — user-defined collections (manual + filter-rule based).
//!   V1 ships with the section structure + a "new workspace" affordance;
//!   functionality lands in a later phase.
//! - **Library**
//!     - **Sources** — pinned source folders (any library root or subfolder
//!       thereof). User-driven via the "Pin source" button at the bottom of
//!       the subsection.
//!     - **Types** — one page per media category (Images, Videos, Animations,
//!       Audio, Models). Each will land as a pre-filtered Library view; V1
//!       stubs the destination.
//! - **Management**
//!     - **Functions** — Plugins manager + Automations.
//!     - **Settings** — split into subsections (Library Roots, Appearance,
//!       General). The existing roots-management UX lives under Library Roots.
//!     - **App** — Stats (startup-time breakdown and other diagnostics),
//!       Keybinds (keyboard-shortcut reference), and About. These describe
//!       the running app itself, separate from user-configurable Settings.
//!
//! Clicking the Garnet logo/title returns to the all-assets root view.

import { useEffect, useMemo } from "react";
import { NavLink, Link, useNavigate, useParams } from "react-router-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import type { IconType } from "react-icons";
import {
	HiBolt,
	HiChartBar,
	HiCog6Tooth,
	HiCommandLine,
	HiCube,
	HiEllipsisHorizontalCircle,
	HiFilm,
	HiFolder,
	HiFolderOpen,
	HiFolderPlus,
	HiGlobeAlt,
	HiInformationCircle,
	HiMusicalNote,
	HiPhoto,
	HiPlus,
	HiPuzzlePiece,
	HiSparkles,
	HiSquares2X2,
	HiSwatch,
	HiTrash,
} from "react-icons/hi2";
import { confirm } from "@/components/ConfirmDialog";
import { openContextMenu } from "@/components/ContextMenu";
import type { PinnedSource } from "@/lib/tauri";
import { useLibraryStore } from "@/stores/libraryStore";
import { usePinnedSourcesStore } from "@/stores/pinnedSourcesStore";

export function Sidebar() {
	const { sources, refresh, pin, unpin, error: pinError } = usePinnedSourcesStore();
	const roots = useLibraryStore((s) => s.roots);
	const navigate = useNavigate();
	const params = useParams<{ id?: string }>();
	const activeSourceId = params.id ? Number(params.id) : null;

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function handleRemovePin(source: PinnedSource) {
		const ok = await confirm({
			title: "Remove pinned source?",
			message: `“${source.name}” will be removed from the sidebar. The folder and its files are not affected.`,
			confirmLabel: "Remove pin",
			danger: true,
		});
		if (!ok) return;
		// If the user is currently viewing the source about to be removed,
		// drop them back to All Sources so the view doesn't show a stale filter.
		if (activeSourceId === source.id) navigate("/", { replace: true });
		await unpin(source.id);
	}

	function handlePinnedSourceContextMenu(
		event: React.MouseEvent,
		source: PinnedSource,
	) {
		openContextMenu(event, [
			{
				label: "Open folder",
				icon: HiFolderOpen,
				onClick: () => openPath(source.abs_path).catch(() => undefined),
			},
			{ kind: "separator" },
			{
				label: "Remove pin",
				icon: HiTrash,
				danger: true,
				onClick: () => handleRemovePin(source),
			},
		]);
	}

	// Pre-pick a sensible starting directory for the folder picker: the most
	// recently-added library root, if any.
	const defaultPickerPath = useMemo(() => {
		if (roots.length === 0) return undefined;
		return roots[roots.length - 1].path;
	}, [roots]);

	async function handlePinSource() {
		const selected = await openDialog({
			directory: true,
			multiple: false,
			defaultPath: defaultPickerPath,
			title: "Pin a folder inside one of your library roots",
		});
		if (typeof selected !== "string") return;
		await pin(selected);
	}

	return (
		<aside className="w-60 shrink-0 bg-base-100 border-r border-base-300 flex flex-col">
			<Link
				to="/"
				className="px-4 py-3.5 border-b border-base-300 flex items-center gap-2.5 hover:bg-base-200/60 transition-colors"
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

			<nav className="flex-1 overflow-y-auto py-3 px-2 divide-y divide-base-300 [&>*]:py-6 [&>*:first-child]:pt-1 [&>*:last-child]:pb-2">
				<NavGroup title="Workspaces">
					<ul className="flex flex-col gap-0.5 pl-1">
						<NavAction icon={HiPlus} disabled>
							New workspace
						</NavAction>
					</ul>
				</NavGroup>

				<NavGroup title="Library">
					<NavSection title="Sources">
						{/* "All Sources" is the default landing view at /,
						    showing every asset across every library root. It's
						    deliberately non-editable — it isn't backed by a
						    pinned_sources row and there's no unpin affordance. */}
						<NavItem to="/" icon={HiGlobeAlt} end>
							All Sources
						</NavItem>
						{sources.map((s) => (
							<NavItem
								key={s.id}
								to={`/sources/${s.id}`}
								icon={s.relative_path === "" ? HiFolder : HiFolderOpen}
								onContextMenu={(e) => handlePinnedSourceContextMenu(e, s)}
							>
								{s.name}
							</NavItem>
						))}
						<NavAction icon={HiFolderPlus} onClick={handlePinSource}>
							Pin source
						</NavAction>
						{pinError && (
							<li className="px-2 py-1 text-[10px] text-error/90 break-words">
								{pinError}
							</li>
						)}
					</NavSection>

					<NavSection title="Types">
						<NavItem to="/types/images" icon={HiPhoto}>Images</NavItem>
						<NavItem to="/types/videos" icon={HiFilm}>Videos</NavItem>
						<NavItem to="/types/audio" icon={HiMusicalNote}>Audio</NavItem>
						<NavItem to="/types/models" icon={HiCube}>Models</NavItem>
						<NavItem to="/types/animations" icon={HiSparkles}>
							Animations
						</NavItem>
						<NavItem to="/types/other" icon={HiEllipsisHorizontalCircle}>
							Other
						</NavItem>
					</NavSection>
				</NavGroup>

				<NavGroup title="Management">
					<NavSection title="Functions">
						<NavItem to="/functions/plugins" icon={HiPuzzlePiece}>
							Plugins
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
					</NavSection>

					<NavSection title="App">
						<NavItem to="/app/stats" icon={HiChartBar}>
							Stats
						</NavItem>
						<NavItem to="/app/keybinds" icon={HiCommandLine}>
							Keybinds
						</NavItem>
						<NavItem to="/app/about" icon={HiInformationCircle}>
							About
						</NavItem>
					</NavSection>
				</NavGroup>
			</nav>

			<footer className="p-3 text-[10px] text-base-content/40 border-t border-base-300 flex items-center justify-between">
				<span>Phase 1 — base toolkit</span>
				<HiSquares2X2 className="size-3 opacity-60" />
			</footer>
		</aside>
	);
}

function NavGroup({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div>
			<div className="text-xs uppercase tracking-wider text-base-content/70 px-2 mb-4 font-bold">
				{title}
			</div>
			<div className="space-y-3">{children}</div>
		</div>
	);
}

function NavSection({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div>
			<div className="text-[10px] uppercase tracking-wider text-base-content/40 px-3 mb-1 font-semibold">
				{title}
			</div>
			<ul className="flex flex-col gap-0.5 pl-1">{children}</ul>
		</div>
	);
}

function NavItem({
	to,
	icon: Icon,
	children,
	end,
	onContextMenu,
}: {
	to: string;
	icon: IconType;
	children: React.ReactNode;
	/** Pass through to NavLink — required when the route is `/` so partial
	 * prefix matches against deeper routes don't keep the item highlighted. */
	end?: boolean;
	onContextMenu?: (e: React.MouseEvent) => void;
}) {
	return (
		<li>
			<NavLink
				to={to}
				end={end}
				onContextMenu={onContextMenu}
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
