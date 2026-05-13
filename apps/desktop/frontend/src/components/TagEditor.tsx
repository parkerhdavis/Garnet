// SPDX-License-Identifier: AGPL-3.0-or-later
//! In-place tag editor for a single asset. Shows existing tags as removable
//! chips; an inline combobox lets the user pick from existing tags or create
//! a new one by typing. Used in both the DetailsSidebar and the AssetDetailPage.

import { useEffect, useMemo, useRef, useState } from "react";
import { HiPlus, HiXMark } from "react-icons/hi2";
import { api, type Tag, type TagWithCount } from "@/lib/tauri";
import { useAssetsStore } from "@/stores/assetsStore";

type Props = {
	assetId: number;
};

export function TagEditor({ assetId }: Props) {
	const [tags, setTags] = useState<Tag[]>([]);
	const [allTags, setAllTags] = useState<TagWithCount[]>([]);
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const refreshStore = useAssetsStore((s) => s.refresh);

	const refreshLocal = async () => {
		const [a, b] = await Promise.all([api.listAssetTags(assetId), api.listTags()]);
		setTags(a);
		setAllTags(b);
	};

	useEffect(() => {
		void refreshLocal();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [assetId]);

	useEffect(() => {
		if (adding) inputRef.current?.focus();
	}, [adding]);

	const suggestions = useMemo(() => {
		const q = draft.trim().toLowerCase();
		const taken = new Set(tags.map((t) => t.id));
		return allTags
			.filter((t) => !taken.has(t.id))
			.filter((t) => (q === "" ? true : t.name.toLowerCase().includes(q)))
			.slice(0, 8);
	}, [allTags, tags, draft]);

	async function attach(tagId: number) {
		setSubmitting(true);
		try {
			await api.tagAsset(assetId, tagId);
			setDraft("");
			setAdding(false);
			await refreshLocal();
			await refreshStore();
		} finally {
			setSubmitting(false);
		}
	}

	async function createAndAttach() {
		const name = draft.trim();
		if (!name) return;
		setSubmitting(true);
		try {
			const tag = await api.createTag(name);
			await api.tagAsset(assetId, tag.id);
			setDraft("");
			setAdding(false);
			await refreshLocal();
			await refreshStore();
		} finally {
			setSubmitting(false);
		}
	}

	async function detach(tagId: number) {
		await api.untagAsset(assetId, tagId);
		await refreshLocal();
		await refreshStore();
	}

	const exactMatch = allTags.find(
		(t) => t.name.toLowerCase() === draft.trim().toLowerCase(),
	);

	return (
		<div className="flex flex-wrap gap-1.5 items-center">
			{tags.map((t) => (
				<span key={t.id} className="badge badge-sm badge-primary gap-1">
					{t.name}
					<button
						type="button"
						className="hover:opacity-80"
						onClick={() => detach(t.id)}
						aria-label={`Remove ${t.name}`}
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
					Add tag
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
								if (exactMatch && !tags.some((t) => t.id === exactMatch.id)) {
									void attach(exactMatch.id);
								} else if (draft.trim()) {
									void createAndAttach();
								}
							}
						}}
						placeholder="Tag name…"
						className="input input-xs input-bordered w-32"
						disabled={submitting}
					/>
					{(suggestions.length > 0 || draft.trim()) && (
						<div className="absolute top-full mt-1 left-0 z-20 menu menu-xs bg-base-100 border border-base-300 rounded-box w-40 shadow-md">
							{suggestions.map((t) => (
								<button
									key={t.id}
									type="button"
									className="text-left px-2 py-1 hover:bg-base-200 rounded"
									onMouseDown={(e) => {
										e.preventDefault();
										void attach(t.id);
									}}
								>
									{t.name}{" "}
									<span className="opacity-50">· {t.count}</span>
								</button>
							))}
							{draft.trim() && !exactMatch && (
								<button
									type="button"
									className="text-left px-2 py-1 hover:bg-base-200 rounded text-primary"
									onMouseDown={(e) => {
										e.preventDefault();
										void createAndAttach();
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
	);
}
