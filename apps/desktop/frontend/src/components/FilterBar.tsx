// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import {
	HiMagnifyingGlass,
	HiSquares2X2,
	HiBars3,
	HiXMark,
} from "react-icons/hi2";
import { useAssetsStore } from "@/stores/assetsStore";
import { useLibraryStore } from "@/stores/libraryStore";

const SIZE_PRESETS = [
	{ label: "Any size", min: null as number | null, max: null as number | null },
	{ label: "< 100 KB", min: null, max: 100 * 1024 },
	{ label: "100 KB – 1 MB", min: 100 * 1024, max: 1024 * 1024 },
	{ label: "1 – 10 MB", min: 1024 * 1024, max: 10 * 1024 * 1024 },
	{ label: "10 – 100 MB", min: 10 * 1024 * 1024, max: 100 * 1024 * 1024 },
	{ label: "> 100 MB", min: 100 * 1024 * 1024, max: null },
];

const DATE_PRESETS = (() => {
	const now = Math.floor(Date.now() / 1000);
	const day = 86_400;
	return [
		{ label: "Any time", from: null as number | null },
		{ label: "Last 24 hours", from: now - day },
		{ label: "Last 7 days", from: now - 7 * day },
		{ label: "Last 30 days", from: now - 30 * day },
		{ label: "Last year", from: now - 365 * day },
	];
})();

export function FilterBar() {
	const {
		rootId,
		formats,
		tagIds,
		pathSearch,
		sizeMin,
		sizeMax,
		mtimeFrom,
		formatCounts,
		tagCounts,
		viewMode,
		setRootId,
		toggleFormat,
		clearFormats,
		toggleTagFilter,
		clearTagFilter,
		setPathSearch,
		setSizeMin,
		setSizeMax,
		setMtimeFrom,
		setViewMode,
		resetFilters,
	} = useAssetsStore();
	const { roots } = useLibraryStore();

	// Local debounced state for the search box so we don't refire the query
	// on every keystroke.
	const [searchDraft, setSearchDraft] = useState(pathSearch);
	useEffect(() => {
		setSearchDraft(pathSearch);
	}, [pathSearch]);
	useEffect(() => {
		const t = setTimeout(() => {
			if (searchDraft !== pathSearch) void setPathSearch(searchDraft);
		}, 250);
		return () => clearTimeout(t);
	}, [searchDraft, pathSearch, setPathSearch]);

	const activeSizePreset =
		SIZE_PRESETS.findIndex((p) => p.min === sizeMin && p.max === sizeMax) ?? 0;
	const activeDatePreset = DATE_PRESETS.findIndex((p) => p.from === mtimeFrom) ?? 0;

	const anyFilterActive =
		formats.length > 0 ||
		tagIds.length > 0 ||
		pathSearch !== "" ||
		sizeMin !== null ||
		sizeMax !== null ||
		mtimeFrom !== null;

	return (
		<div className="flex flex-col gap-3 px-6 py-4 bg-base-100 border-b border-base-300 sticky top-0 z-10">
			<div className="flex items-center gap-3">
				<label className="input input-sm input-bordered flex items-center gap-2 flex-1 max-w-md">
					<HiMagnifyingGlass className="size-4 opacity-60" />
					<input
						type="text"
						placeholder="Search filename or path…"
						value={searchDraft}
						onChange={(e) => setSearchDraft(e.target.value)}
						className="grow"
					/>
					{searchDraft && (
						<button
							type="button"
							className="opacity-60 hover:opacity-100"
							onClick={() => setSearchDraft("")}
							aria-label="Clear search"
						>
							<HiXMark className="size-4" />
						</button>
					)}
				</label>

				<select
					className="select select-sm select-bordered"
					value={rootId === null ? "" : rootId}
					onChange={(e) =>
						setRootId(e.target.value === "" ? null : Number(e.target.value))
					}
					aria-label="Source root"
				>
					<option value="">All sources</option>
					{roots.map((r) => (
						<option key={r.id} value={r.id}>
							{abbreviatePath(r.path)}
						</option>
					))}
				</select>

				<select
					className="select select-sm select-bordered"
					value={activeSizePreset === -1 ? 0 : activeSizePreset}
					onChange={(e) => {
						const preset = SIZE_PRESETS[Number(e.target.value)];
						void setSizeMin(preset.min);
						void setSizeMax(preset.max);
					}}
					aria-label="Size filter"
				>
					{SIZE_PRESETS.map((p, i) => (
						<option key={p.label} value={i}>
							{p.label}
						</option>
					))}
				</select>

				<select
					className="select select-sm select-bordered"
					value={activeDatePreset === -1 ? 0 : activeDatePreset}
					onChange={(e) => {
						const preset = DATE_PRESETS[Number(e.target.value)];
						void setMtimeFrom(preset.from);
					}}
					aria-label="Date filter"
				>
					{DATE_PRESETS.map((p, i) => (
						<option key={p.label} value={i}>
							{p.label}
						</option>
					))}
				</select>

				<div className="join">
					<button
						type="button"
						className={`btn btn-sm join-item ${viewMode === "grid" ? "btn-primary" : ""}`}
						onClick={() => setViewMode("grid")}
						aria-label="Grid view"
					>
						<HiSquares2X2 className="size-4" />
					</button>
					<button
						type="button"
						className={`btn btn-sm join-item ${viewMode === "list" ? "btn-primary" : ""}`}
						onClick={() => setViewMode("list")}
						aria-label="List view"
					>
						<HiBars3 className="size-4" />
					</button>
				</div>

				{anyFilterActive && (
					<button
						type="button"
						className="btn btn-sm btn-ghost"
						onClick={() => {
							setSearchDraft("");
							void resetFilters();
						}}
					>
						Reset
					</button>
				)}
			</div>

			{formatCounts.length > 0 && (
				<div className="flex flex-wrap gap-1.5 items-center">
					<span className="text-xs text-base-content/60 mr-1">Formats:</span>
					{formatCounts.slice(0, 14).map((fc) => {
						const key = fc.format ?? "__null__";
						const label = fc.format ?? "(none)";
						const active = fc.format !== null && formats.includes(fc.format);
						return (
							<button
								key={key}
								type="button"
								className={`badge badge-sm cursor-pointer ${active ? "badge-primary" : "badge-ghost"}`}
								disabled={fc.format === null}
								onClick={() => fc.format && toggleFormat(fc.format)}
							>
								{label} · {fc.count.toLocaleString()}
							</button>
						);
					})}
					{formats.length > 0 && (
						<button
							type="button"
							className="badge badge-sm badge-outline ml-2"
							onClick={() => clearFormats()}
						>
							Clear ✕
						</button>
					)}
				</div>
			)}

			{tagCounts.length > 0 && (
				<div className="flex flex-wrap gap-1.5 items-center">
					<span className="text-xs text-base-content/60 mr-1">Tags:</span>
					{tagCounts.slice(0, 20).map((t) => {
						const active = tagIds.includes(t.id);
						return (
							<button
								key={t.id}
								type="button"
								className={`badge badge-sm cursor-pointer ${active ? "badge-accent" : "badge-ghost"}`}
								onClick={() => toggleTagFilter(t.id)}
							>
								{t.name} · {t.count.toLocaleString()}
							</button>
						);
					})}
					{tagIds.length > 0 && (
						<button
							type="button"
							className="badge badge-sm badge-outline ml-2"
							onClick={() => clearTagFilter()}
						>
							Clear ✕
						</button>
					)}
				</div>
			)}
		</div>
	);
}

function abbreviatePath(p: string): string {
	const parts = p.split("/").filter(Boolean);
	if (parts.length <= 2) return p;
	return `…/${parts.slice(-2).join("/")}`;
}
