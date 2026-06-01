// SPDX-License-Identifier: AGPL-3.0-or-later
//! Builder for the asset right-click menu. Shared between AssetGrid and
//! AssetList so the menu items, dialogs, undo wiring, and refresh-after-op
//! behavior stay in one place.
//!
//! Each action records itself on the undo store *after* succeeding, so a
//! failed op (e.g., source already moved on disk) doesn't leave a dangling
//! history entry.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
	HiArrowPath,
	HiArrowsRightLeft,
	HiDocumentDuplicate,
	HiPencilSquare,
	HiTrash,
} from "react-icons/hi2";
import type { Asset } from "@/lib/tauri";
import { api } from "@/lib/tauri";
import { absPathFor, basename, dirname } from "@/lib/paths";
import { batchRename } from "@/components/BatchRenameDialog";
import { confirm } from "@/components/ConfirmDialog";
import type { ContextMenuItem } from "@/components/ContextMenu";
import { prompt } from "@/components/PromptDialog";
import { useAssetsStore } from "@/stores/assetsStore";
import { useSelectionStore } from "@/stores/selectionStore";
import { useUndoStore } from "@/stores/undoStore";
import { loadModelThumbnailer } from "@/lib/loadModelThumbnailer";

const RENDERABLE_MODEL_EXTS = new Set([
	"gltf",
	"glb",
	"obj",
	"stl",
	"ply",
	"fbx",
]);
function isRenderableModelAsset(asset: Asset): boolean {
	const ext = asset.format?.toLowerCase();
	return !!ext && RENDERABLE_MODEL_EXTS.has(ext);
}

/// Trigger a refresh of the visible library view + format/tag facets so the
/// UI reflects whatever just changed on disk.
function refresh() {
	void useAssetsStore.getState().refresh();
}

/// Surface an error to the user via the LibraryPage's inline alert banner.
/// Webkit2gtk silently drops `window.alert()` in Tauri windows on Linux, so
/// rolling our own visible channel is the only reliable feedback path.
function showError(message: string) {
	useAssetsStore.setState({ error: message });
	console.error(message);
}

/// Returns the menu items for right-clicking an asset. The handlers are
/// imperative: they open dialogs, run the IPC call, and push the inverse
/// onto the undo stack on success.
///
/// `visibleAssets` (the current page's rows) lets the menu act on a multi-
/// selection: when two or more selected rows include the right-clicked one,
/// the menu switches to batch actions (rename N, copy N) over that selection.
export function buildAssetContextMenu(
	asset: Asset,
	visibleAssets?: Asset[],
): ContextMenuItem[] {
	const selIds = useSelectionStore.getState().ids;
	const pool = visibleAssets ?? [asset];
	const selected = pool.filter((a) => selIds.has(a.id));
	if (selected.length > 1 && selIds.has(asset.id)) {
		return [
			{
				label: `Rename ${selected.length} items…`,
				icon: HiPencilSquare,
				onClick: () => batchRenameAction(selected),
			},
			{
				label: `Copy ${selected.length} items to…`,
				icon: HiDocumentDuplicate,
				onClick: () => copyManyAction(selected),
			},
			{ kind: "separator" },
			{
				label: `Trash ${selected.length} items`,
				icon: HiTrash,
				danger: true,
				onClick: () => trashManyAction(selected),
			},
		];
	}

	const items: ContextMenuItem[] = [
		{
			label: "Rename…",
			icon: HiPencilSquare,
			onClick: () => renameAction(asset),
		},
		{
			label: "Copy to…",
			icon: HiDocumentDuplicate,
			onClick: () => copyAction(asset),
		},
		{
			label: "Move to…",
			icon: HiArrowsRightLeft,
			onClick: () => moveAction(asset),
		},
	];
	if (isRenderableModelAsset(asset)) {
		items.push({
			label: "Refresh Thumbnail",
			icon: HiArrowPath,
			onClick: () => refreshModelThumbnailAction(asset),
		});
	}
	items.push({ kind: "separator" });
	items.push({
		label: "Trash",
		icon: HiTrash,
		danger: true,
		onClick: () => trashAction(asset),
	});
	return items;
}

/// Open a single-folder picker, defaulting near `near`'s current location.
/// Returns the chosen absolute path, or null on cancel / error.
async function pickDir(title: string, near: Asset): Promise<string | null> {
	const defaultDir =
		`${near.root_path}/${dirname(near.relative_path) || ""}`.replace(/\/$/, "");
	try {
		const selected = await openDialog({
			directory: true,
			multiple: false,
			defaultPath: defaultDir || near.root_path,
			title,
		});
		return typeof selected === "string" ? selected : null;
	} catch (err) {
		showError(`Folder picker failed: ${String(err)}`);
		return null;
	}
}

async function copyAction(asset: Asset) {
	const filename = basename(asset.relative_path);
	const destDir = await pickDir(`Copy “${filename}” to…`, asset);
	if (destDir === null) return;

	let result: Awaited<ReturnType<typeof api.copyAsset>>;
	try {
		result = await api.copyAsset(asset.id, destDir);
	} catch (err) {
		showError(`Copy failed: ${String(err)}`);
		return;
	}
	refresh();

	// Undo trashes the copy by path (it may have been indexed as a new asset
	// by now, so we can't address it by id); redo re-copies from the
	// untouched source.
	useUndoStore.getState().push({
		description: `Copy ${filename}`,
		undo: async () => {
			await api.trashFile(result.copied_abs_path);
			refresh();
		},
		redo: async () => {
			await api.copyAsset(asset.id, destDir);
			refresh();
		},
	});
}

async function copyManyAction(assets: Asset[]) {
	const destDir = await pickDir(`Copy ${assets.length} items to…`, assets[0]);
	if (destDir === null) return;

	const copiedPaths: string[] = [];
	try {
		for (const a of assets) {
			const r = await api.copyAsset(a.id, destDir);
			copiedPaths.push(r.copied_abs_path);
		}
	} catch (err) {
		showError(`Copy failed: ${String(err)}`);
		refresh();
		return;
	}
	refresh();

	useUndoStore.getState().push({
		description: `Copy ${assets.length} items`,
		undo: async () => {
			for (const p of copiedPaths) {
				await api.trashFile(p).catch(() => undefined);
			}
			refresh();
		},
		redo: async () => {
			for (const a of assets) {
				await api.copyAsset(a.id, destDir).catch(() => undefined);
			}
			refresh();
		},
	});
}

async function batchRenameAction(assets: Asset[]) {
	const pairs = await batchRename(assets);
	if (pairs === null || pairs.length === 0) return;

	// Snapshot the original names (for the renamed subset) before applying, so
	// undo can put them back through the same collision-safe path.
	const originals = pairs.map((p) => {
		const a = assets.find((x) => x.id === p.asset_id);
		return { asset_id: p.asset_id, new_name: basename(a?.relative_path ?? "") };
	});

	try {
		await api.renameAssets(pairs);
	} catch (err) {
		showError(`Rename failed: ${String(err)}`);
		return;
	}
	refresh();

	useUndoStore.getState().push({
		description: `Rename ${pairs.length} items`,
		undo: async () => {
			await api.renameAssets(originals);
			refresh();
		},
		redo: async () => {
			await api.renameAssets(pairs);
			refresh();
		},
	});
}

async function trashManyAction(assets: Asset[]) {
	const ok = await confirm({
		title: `Trash ${assets.length} items?`,
		message: `These will be moved to Garnet's trash folder. You can undo this with Ctrl+Z.`,
		confirmLabel: "Trash",
		danger: true,
	});
	if (!ok) return;

	// One restore/re-trash record per asset, mirroring the single trash flow.
	const entries: { trashPath: string; originalPath: string; rootId: number }[] =
		[];
	try {
		for (const a of assets) {
			const res = await api.trashAsset(a.id);
			entries.push({
				trashPath: res.trash_path,
				originalPath: res.original_abs_path,
				rootId: a.root_id,
			});
		}
	} catch (err) {
		showError(`Trash failed: ${String(err)}`);
		refresh();
		return;
	}
	refresh();

	useUndoStore.getState().push({
		description: `Trash ${assets.length} items`,
		undo: async () => {
			for (const e of entries) {
				await api
					.restoreFromTrash(e.trashPath, e.originalPath)
					.catch(() => undefined);
			}
			refresh();
		},
		redo: async () => {
			// Each restored file re-indexes under a fresh id; look it up by its
			// original path before re-trashing, and rebind the trash path.
			for (const e of entries) {
				const found = await waitForAssetAtPath(e.originalPath, e.rootId);
				if (found) {
					const re = await api.trashAsset(found.id);
					e.trashPath = re.trash_path;
				}
			}
			refresh();
		},
	});
}

async function refreshModelThumbnailAction(asset: Asset) {
	try {
		const thumbnailer = await loadModelThumbnailer();
		const ok = await thumbnailer.request(
			asset.id,
			absPathFor(asset),
			asset.mtime,
			240,
			asset.format,
			{ force: true },
		);
		if (!ok) showError("Couldn't render a thumbnail for this model.");
	} catch (err) {
		showError(`Refresh thumbnail failed: ${String(err)}`);
	}
}

async function renameAction(asset: Asset) {
	const currentName = basename(asset.relative_path);
	// Pre-select the filename stem so overtyping renames the file but
	// preserves the extension. Most rename flows want this.
	const dotIndex = currentName.lastIndexOf(".");
	const selection =
		dotIndex > 0
			? { start: 0, end: dotIndex }
			: { start: 0, end: currentName.length };

	const newName = await prompt({
		title: "Rename asset",
		message: asset.relative_path,
		initialValue: currentName,
		selection,
		confirmLabel: "Rename",
		validate: (v) => {
			const trimmed = v.trim();
			if (!trimmed) return "Name cannot be empty";
			if (trimmed.includes("/") || trimmed.includes("\\"))
				return "Name cannot contain path separators";
			if (trimmed === currentName) return "Name is unchanged";
			return null;
		},
	});
	if (newName === null) return;

	try {
		await api.renameAsset(asset.id, newName);
	} catch (err) {
		showError(`Rename failed: ${String(err)}`);
		return;
	}
	refresh();
	useUndoStore.getState().push({
		description: `Rename ${currentName} → ${newName}`,
		undo: async () => {
			await api.renameAsset(asset.id, currentName);
			refresh();
		},
		redo: async () => {
			await api.renameAsset(asset.id, newName);
			refresh();
		},
	});
}

async function moveAction(asset: Asset) {
	const defaultDir =
		`${asset.root_path}/${dirname(asset.relative_path) || ""}`.replace(
			/\/$/,
			"",
		);
	let selected: string | string[] | null;
	try {
		selected = await openDialog({
			directory: true,
			multiple: false,
			defaultPath: defaultDir || asset.root_path,
			title: `Move “${basename(asset.relative_path)}” to…`,
		});
	} catch (err) {
		showError(`Folder picker failed: ${String(err)}`);
		return;
	}
	if (typeof selected !== "string") return;
	const destDir = selected;

	const filename = basename(asset.relative_path);
	const originalDir =
		`${asset.root_path}/${dirname(asset.relative_path)}`.replace(/\/$/, "");

	let result: Awaited<ReturnType<typeof api.moveAsset>>;
	try {
		result = await api.moveAsset(asset.id, destDir);
	} catch (err) {
		showError(`Move failed: ${String(err)}`);
		return;
	}
	refresh();

	// Path-keyed undo/redo: works the same whether the row was re-keyed
	// (in-library move) or deleted (out-of-library move). The watcher's
	// rescan re-inserts the row on its own after each replay.
	const newAbsPath = result.abs_path;
	useUndoStore.getState().push({
		description: `Move ${filename}`,
		undo: async () => {
			await api.moveFile(newAbsPath, originalDir);
			refresh();
		},
		redo: async () => {
			const originalAbsPath = `${originalDir}/${filename}`;
			await api.moveFile(originalAbsPath, destDir);
			refresh();
		},
	});
}

async function trashAction(asset: Asset) {
	const filename = basename(asset.relative_path);
	const ok = await confirm({
		title: "Trash this asset?",
		message: `“${filename}” will be moved to Garnet's trash folder. You can undo this with Ctrl+Z.`,
		confirmLabel: "Trash",
		danger: true,
	});
	if (!ok) return;

	let result: Awaited<ReturnType<typeof api.trashAsset>>;
	try {
		result = await api.trashAsset(asset.id);
	} catch (err) {
		showError(`Trash failed: ${String(err)}`);
		return;
	}
	refresh();

	// Hold onto the trash path + original path so undo can restore. Each
	// successive trash/restore cycle generates a fresh trash_path, so the
	// undo and redo closures rebind their captured values to the latest
	// snapshot after each replay.
	let currentTrashPath = result.trash_path;
	const originalPath = result.original_abs_path;

	useUndoStore.getState().push({
		description: `Trash ${filename}`,
		undo: async () => {
			await api.restoreFromTrash(currentTrashPath, originalPath);
			refresh();
		},
		redo: async () => {
			// Re-trashing requires the file to be back in the library — find
			// the asset by its restored path. The watcher's rescan after
			// restore inserts a new row; if the user redoes before the
			// rescan lands, we look it up explicitly.
			const refreshed = await waitForAssetAtPath(originalPath, asset.root_id);
			if (!refreshed) {
				throw new Error(
					`could not find restored asset at ${originalPath} to re-trash`,
				);
			}
			const re = await api.trashAsset(refreshed.id);
			currentTrashPath = re.trash_path;
			refresh();
		},
	});
}

/// Polls the asset list until a row with the given absolute path appears
/// (or the timeout elapses). Used by `redo` after a trash-undo to find the
/// re-indexed asset before re-trashing it.
async function waitForAssetAtPath(
	absPath: string,
	rootId: number,
): Promise<{ id: number } | null> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const page = await api.listAssets({
			root_id: rootId,
			limit: 5_000,
		});
		const match = page.assets.find(
			(a) => `${a.root_path}/${a.relative_path}` === absPath,
		);
		if (match) return { id: match.id };
		await new Promise((r) => setTimeout(r, 250));
	}
	return null;
}
