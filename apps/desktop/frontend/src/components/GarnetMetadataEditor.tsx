// SPDX-License-Identifier: AGPL-3.0-or-later
//! Per-asset editor for the `garnet_metadata` table — Garnet's user-editable
//! key/value(/multi-value) store. Tags are not special at the data layer
//! (they're values of the `tags` key); the UI still treats the `tags` key as
//! a built-in row with autocomplete from prior tag values across the library,
//! since that's the longest-established use case.

import { useEffect, useMemo, useRef, useState } from "react";
import { HiPlus, HiTrash, HiXMark } from "react-icons/hi2";
import { api, type GarnetMetadataEntry, type ValueCount } from "@/lib/tauri";
import { useAssetsStore } from "@/stores/assetsStore";

const TAGS_KEY = "tags";

type Props = {
	assetId: number;
};

export function GarnetMetadataEditor({ assetId }: Props) {
	const [entries, setEntries] = useState<GarnetMetadataEntry[]>([]);
	const [tagSuggestions, setTagSuggestions] = useState<ValueCount[]>([]);
	const [addingKey, setAddingKey] = useState(false);
	const [newKey, setNewKey] = useState("");
	const refreshStore = useAssetsStore((s) => s.refresh);

	const refreshLocal = async () => {
		const [list, tags] = await Promise.all([
			api.listGarnetMetadata(assetId),
			api.listGarnetMetadataValuesForKey(TAGS_KEY),
		]);
		setEntries(list);
		setTagSuggestions(tags);
	};

	useEffect(() => {
		void refreshLocal();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [assetId]);

	async function addValue(key: string, value: string) {
		const v = value.trim();
		if (!v) return;
		await api.addGarnetMetadataValue(assetId, key, v);
		await refreshLocal();
		// Tag changes affect the global tag-filter chip list — refresh the
		// shared assets view as well so the FilterBar stays in sync.
		if (key === TAGS_KEY) void refreshStore();
	}

	async function removeValue(key: string, value: string) {
		await api.removeGarnetMetadataValue(assetId, key, value);
		await refreshLocal();
		if (key === TAGS_KEY) void refreshStore();
	}

	async function removeKey(key: string) {
		await api.removeGarnetMetadataKey(assetId, key);
		await refreshLocal();
		if (key === TAGS_KEY) void refreshStore();
	}

	// Ensure the well-known `tags` row always renders (even when empty), so
	// the user has a discoverable affordance for the most common case.
	const orderedEntries = useMemo(() => {
		const hasTags = entries.some((e) => e.key === TAGS_KEY);
		if (hasTags) return entries;
		return [{ key: TAGS_KEY, values: [] }, ...entries];
	}, [entries]);

	async function handleAddKey() {
		const key = newKey.trim();
		if (!key) {
			setAddingKey(false);
			return;
		}
		// The actual row appears once a value lands; until then we just open
		// an inline draft for the new key. Promote it to state by creating an
		// empty entry locally.
		setNewKey("");
		setAddingKey(false);
		if (!entries.some((e) => e.key === key)) {
			setEntries((prev) => [...prev, { key, values: [] }]);
		}
	}

	return (
		<div className="space-y-3 text-xs">
			{orderedEntries.map((entry) => (
				<MetadataRow
					key={entry.key}
					entry={entry}
					assetId={assetId}
					tagSuggestions={tagSuggestions}
					onAddValue={(v) => addValue(entry.key, v)}
					onRemoveValue={(v) => removeValue(entry.key, v)}
					onRemoveKey={() => removeKey(entry.key)}
				/>
			))}

			{addingKey ? (
				<div className="flex items-center gap-1.5">
					<input
						autoFocus
						type="text"
						value={newKey}
						onChange={(e) => setNewKey(e.target.value)}
						onBlur={() => setTimeout(() => setAddingKey(false), 150)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								void handleAddKey();
							} else if (e.key === "Escape") {
								setAddingKey(false);
								setNewKey("");
							}
						}}
						placeholder="metadata key…"
						className="input input-xs input-bordered flex-1"
					/>
				</div>
			) : (
				<button
					type="button"
					className="text-[11px] text-base-content/55 hover:text-base-content flex items-center gap-1"
					onClick={() => setAddingKey(true)}
				>
					<HiPlus className="size-3" />
					Add metadata key
				</button>
			)}
		</div>
	);
}

function MetadataRow({
	entry,
	tagSuggestions,
	onAddValue,
	onRemoveValue,
	onRemoveKey,
}: {
	entry: GarnetMetadataEntry;
	assetId: number;
	tagSuggestions: ValueCount[];
	onAddValue: (value: string) => Promise<void>;
	onRemoveValue: (value: string) => Promise<void>;
	onRemoveKey: () => Promise<void>;
}) {
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const isTags = entry.key === TAGS_KEY;

	useEffect(() => {
		if (adding) inputRef.current?.focus();
	}, [adding]);

	const suggestions = useMemo(() => {
		if (!isTags) return [];
		const q = draft.trim().toLowerCase();
		const taken = new Set(entry.values.map((v) => v.toLowerCase()));
		return tagSuggestions
			.filter((s) => !taken.has(s.value.toLowerCase()))
			.filter((s) => (q === "" ? true : s.value.toLowerCase().includes(q)))
			.slice(0, 8);
	}, [tagSuggestions, entry.values, draft, isTags]);

	const exactMatch = isTags
		? tagSuggestions.find((s) => s.value.toLowerCase() === draft.trim().toLowerCase())
		: undefined;

	async function commitDraft(value: string) {
		const v = value.trim();
		if (!v) {
			setAdding(false);
			return;
		}
		setSubmitting(true);
		try {
			await onAddValue(v);
			setDraft("");
			setAdding(false);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="group">
			<div className="flex items-center justify-between gap-2 mb-1">
				<span
					className="font-mono text-[10px] uppercase tracking-wider text-base-content/55"
					title={entry.key}
				>
					{entry.key}
				</span>
				{!isTags && (
					<button
						type="button"
						className="opacity-0 group-hover:opacity-100 text-base-content/40 hover:text-error transition-opacity"
						onClick={() => void onRemoveKey()}
						aria-label={`Remove ${entry.key} key`}
						title="Remove this key"
					>
						<HiTrash className="size-3" />
					</button>
				)}
			</div>

			<div className="flex flex-wrap items-center gap-1.5">
				{entry.values.map((v) => (
					<span
						key={v}
						className={`badge badge-sm gap-1 ${
							isTags ? "badge-primary" : "badge-ghost"
						}`}
					>
						{v}
						<button
							type="button"
							className="hover:opacity-80"
							onClick={() => void onRemoveValue(v)}
							aria-label={`Remove ${v}`}
						>
							<HiXMark className="size-3" />
						</button>
					</span>
				))}

				{!adding ? (
					<button
						type="button"
						className="badge badge-sm badge-outline cursor-pointer"
						onClick={() => setAdding(true)}
					>
						<HiPlus className="size-3" />
						{isTags ? "Add tag" : "Add value"}
					</button>
				) : (
					<div className="relative inline-block">
						<input
							ref={inputRef}
							type="text"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onBlur={() => setTimeout(() => setAdding(false), 150)}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									setAdding(false);
									setDraft("");
								} else if (e.key === "Enter") {
									e.preventDefault();
									void commitDraft(draft);
								}
							}}
							placeholder={isTags ? "Tag name…" : "Value…"}
							className="input input-xs input-bordered w-32"
							disabled={submitting}
						/>
						{isTags && (suggestions.length > 0 || draft.trim()) && (
							<div className="absolute top-full mt-1 left-0 z-20 menu menu-xs bg-base-100 border border-base-300 rounded-box w-40 shadow-md">
								{suggestions.map((s) => (
									<button
										key={s.value}
										type="button"
										className="text-left px-2 py-1 hover:bg-base-200 rounded"
										onMouseDown={(e) => {
											e.preventDefault();
											void commitDraft(s.value);
										}}
									>
										{s.value}{" "}
										<span className="opacity-50">· {s.count}</span>
									</button>
								))}
								{draft.trim() && !exactMatch && (
									<button
										type="button"
										className="text-left px-2 py-1 hover:bg-base-200 rounded text-primary"
										onMouseDown={(e) => {
											e.preventDefault();
											void commitDraft(draft);
										}}
									>
										Create &quot;{draft.trim()}&quot;
									</button>
								)}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
