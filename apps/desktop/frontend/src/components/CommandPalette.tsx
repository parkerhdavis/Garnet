// SPDX-License-Identifier: AGPL-3.0-or-later
//! Ctrl+K command palette: a single search box over assets (catalog-wide),
//! workspaces, and navigation/commands. Mounted in Layout so it has router
//! context; toggled via useCommandPaletteStore (App-level hotkey). Asset search
//! hits the backend (debounced); workspaces and commands filter in-memory.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { IconType } from "react-icons";
import {
	HiBolt,
	HiChartBar,
	HiCog6Tooth,
	HiCommandLine,
	HiCube,
	HiDocumentArrowUp,
	HiDocumentDuplicate,
	HiEllipsisHorizontalCircle,
	HiFilm,
	HiFolder,
	HiGlobeAlt,
	HiInformationCircle,
	HiMagnifyingGlass,
	HiMusicalNote,
	HiPhoto,
	HiPuzzlePiece,
	HiSparkles,
	HiSquares2X2,
	HiSwatch,
} from "react-icons/hi2";
import { api, type Asset } from "@/lib/tauri";
import { pickFileToPreview } from "@/lib/ephemeral";
import { abbreviatePath, basename } from "@/lib/paths";
import { workspaceTypeMeta } from "@/lib/workspaceTypes";
import type { PaletteItemContribution } from "@/plugins/types";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { enabledPaletteSources, usePluginsStore } from "@/stores/pluginsStore";
import { useWorkspacesStore } from "@/stores/workspacesStore";

const ASSET_LIMIT = 8;

type Item = {
	key: string;
	group: string;
	label: string;
	sublabel?: string;
	icon: IconType;
	run: () => void;
};

export function CommandPalette() {
	const open = useCommandPaletteStore((s) => s.open);
	const close = useCommandPaletteStore((s) => s.close);
	const navigate = useNavigate();
	const workspaces = useWorkspacesStore((s) => s.workspaces);
	// Subscribe so enabledPaletteSources() re-resolves when a plugin is toggled.
	const enabledIds = usePluginsStore((s) => s.enabledIds);

	const [query, setQuery] = useState("");
	const [assets, setAssets] = useState<Asset[]>([]);
	const [pluginGroups, setPluginGroups] = useState<
		{ group: string; items: PaletteItemContribution[] }[]
	>([]);
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);

	// Reset + focus on open.
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setAssets([]);
		setPluginGroups([]);
		setActive(0);
		const t = setTimeout(() => inputRef.current?.focus(), 0);
		return () => clearTimeout(t);
	}, [open]);

	// Debounced catalog search — only fires with a query.
	useEffect(() => {
		if (!open) return;
		const q = query.trim();
		if (!q) {
			setAssets([]);
			return;
		}
		const t = setTimeout(() => {
			void api
				.searchAssets(q, ASSET_LIMIT)
				.then(setAssets)
				.catch(() => setAssets([]));
		}, 200);
		return () => clearTimeout(t);
	}, [query, open]);

	// Debounced plugin-contributed sources (e.g. Music albums/artists). Each
	// runs independently; failures and empties just drop out.
	useEffect(() => {
		if (!open) return;
		const q = query.trim();
		const sources = enabledPaletteSources();
		if (!q || sources.length === 0) {
			setPluginGroups([]);
			return;
		}
		let cancelled = false;
		const t = setTimeout(() => {
			void Promise.all(
				sources.map((s) =>
					s
						.search(q)
						.then((items) => ({ group: s.group, items }))
						.catch(() => ({ group: s.group, items: [] })),
				),
			).then((groups) => {
				if (!cancelled) setPluginGroups(groups.filter((g) => g.items.length));
			});
		}, 200);
		return () => {
			cancelled = true;
			clearTimeout(t);
		};
	}, [query, open, enabledIds]);

	const commands = useMemo<Item[]>(() => {
		const go = (to: string) => () => {
			close();
			navigate(to);
		};
		return [
			{
				key: "go-library",
				group: "Go to",
				label: "Library",
				icon: HiGlobeAlt,
				run: go("/"),
			},
			{
				key: "go-images",
				group: "Go to",
				label: "Images",
				icon: HiPhoto,
				run: go("/types/images"),
			},
			{
				key: "go-videos",
				group: "Go to",
				label: "Videos",
				icon: HiFilm,
				run: go("/types/videos"),
			},
			{
				key: "go-audio",
				group: "Go to",
				label: "Audio",
				icon: HiMusicalNote,
				run: go("/types/audio"),
			},
			{
				key: "go-models",
				group: "Go to",
				label: "Models",
				icon: HiCube,
				run: go("/types/models"),
			},
			{
				key: "go-animations",
				group: "Go to",
				label: "Animations",
				icon: HiSparkles,
				run: go("/types/animations"),
			},
			{
				key: "go-other",
				group: "Go to",
				label: "Other",
				icon: HiEllipsisHorizontalCircle,
				run: go("/types/other"),
			},
			{
				key: "go-duplicates",
				group: "Go to",
				label: "Duplicates",
				icon: HiDocumentDuplicate,
				run: go("/duplicates"),
			},
			{
				key: "go-plugins",
				group: "Go to",
				label: "Plugins",
				icon: HiPuzzlePiece,
				run: go("/functions/plugins"),
			},
			{
				key: "go-automations",
				group: "Go to",
				label: "Automations",
				icon: HiBolt,
				run: go("/functions/automations"),
			},
			{
				key: "go-roots",
				group: "Go to",
				label: "Library Roots",
				icon: HiFolder,
				run: go("/settings/library"),
			},
			{
				key: "go-appearance",
				group: "Go to",
				label: "Appearance",
				icon: HiSwatch,
				run: go("/settings/appearance"),
			},
			{
				key: "go-general",
				group: "Go to",
				label: "General settings",
				icon: HiCog6Tooth,
				run: go("/settings/general"),
			},
			{
				key: "go-stats",
				group: "Go to",
				label: "Stats",
				icon: HiChartBar,
				run: go("/app/stats"),
			},
			{
				key: "go-keybinds",
				group: "Go to",
				label: "Keybinds",
				icon: HiCommandLine,
				run: go("/app/keybinds"),
			},
			{
				key: "go-about",
				group: "Go to",
				label: "About",
				icon: HiInformationCircle,
				run: go("/app/about"),
			},
			{
				key: "act-open-file",
				group: "Actions",
				label: "Open file…",
				icon: HiDocumentArrowUp,
				run: () => {
					close();
					void pickFileToPreview((to) => navigate(to));
				},
			},
		];
	}, [navigate, close]);

	const items = useMemo<Item[]>(() => {
		const q = query.trim().toLowerCase();
		const cmds = q
			? commands.filter((c) => c.label.toLowerCase().includes(q))
			: commands;
		const wss: Item[] = workspaces
			.filter((w) => !q || w.name.toLowerCase().includes(q))
			.map((w) => ({
				key: `ws-${w.id}`,
				group: "Workspaces",
				label: w.name,
				icon: workspaceTypeMeta(w.type).icon,
				run: () => {
					close();
					navigate(`/workspaces/${w.id}`);
				},
			}));
		const plugins: Item[] = pluginGroups.flatMap((g) =>
			g.items.map((it) => ({
				key: `${g.group}-${it.id}`,
				group: g.group,
				label: it.label,
				sublabel: it.sublabel,
				icon: it.icon ?? HiSquares2X2,
				run: () => {
					close();
					navigate(it.to);
				},
			})),
		);
		const ats: Item[] = assets.map((a) => ({
			key: `asset-${a.id}`,
			group: "Assets",
			label: basename(a.relative_path),
			sublabel: abbreviatePath(`${a.root_path}/${a.relative_path}`),
			icon: HiPhoto,
			run: () => {
				close();
				navigate(`/asset/${a.id}`);
			},
		}));
		return [...cmds, ...wss, ...plugins, ...ats];
	}, [commands, workspaces, assets, pluginGroups, query, close, navigate]);

	// Keep the active index in range as results change.
	useEffect(() => {
		setActive((i) => Math.min(i, Math.max(0, items.length - 1)));
	}, [items.length]);

	// Scroll the active row into view.
	useEffect(() => {
		listRef.current
			?.querySelector(`[data-idx="${active}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [active]);

	if (!open) return null;

	function onKeyDown(e: React.KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((i) => Math.min(i + 1, items.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			items[active]?.run();
		} else if (e.key === "Escape") {
			e.preventDefault();
			close();
		}
	}

	return createPortal(
		<div
			className="fixed inset-0 z-[80] flex items-start justify-center bg-black/50 p-6 pt-[12vh]"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) close();
			}}
		>
			<div
				role="dialog"
				aria-modal="true"
				className="w-full max-w-xl overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-2xl"
			>
				<div className="flex items-center gap-2 border-b border-base-300 px-3">
					<HiMagnifyingGlass className="size-4 shrink-0 opacity-50" />
					<input
						ref={inputRef}
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={onKeyDown}
						placeholder="Search assets, workspaces, commands…"
						className="flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-base-content/40"
					/>
				</div>
				<div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
					{items.length === 0 ? (
						<div className="px-4 py-6 text-center text-sm text-base-content/50">
							No matches
						</div>
					) : (
						items.map((item, idx) => {
							const header = idx === 0 || items[idx - 1].group !== item.group;
							const Icon = item.icon;
							return (
								<div key={item.key}>
									{header && (
										<div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-base-content/40">
											{item.group}
										</div>
									)}
									<button
										type="button"
										data-idx={idx}
										onMouseMove={() => setActive(idx)}
										onClick={() => item.run()}
										className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${
											idx === active
												? "bg-primary/15 text-primary"
												: "hover:bg-base-200"
										}`}
									>
										<Icon className="size-4 shrink-0 opacity-80" />
										<span className="min-w-0 flex-1 truncate text-sm">
											{item.label}
										</span>
										{item.sublabel && (
											<span className="max-w-[45%] shrink-0 truncate text-xs text-base-content/45">
												{item.sublabel}
											</span>
										)}
									</button>
								</div>
							);
						})
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}
