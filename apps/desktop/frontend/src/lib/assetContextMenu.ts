// SPDX-License-Identifier: AGPL-3.0-or-later
//! Builder for the asset right-click menu. Shared between AssetGrid and
//! AssetList so the menu items, dialogs, undo wiring, and refresh-after-op
//! behavior stay in one place.
//!
//! Each action records itself on the undo store *after* succeeding, so a
//! failed op (e.g., source already moved on disk) doesn't leave a dangling
//! history entry.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { HiArrowPath, HiArrowsRightLeft, HiPencilSquare, HiTrash } from "react-icons/hi2";
import type { Asset } from "@/lib/tauri";
import { api } from "@/lib/tauri";
import { absPathFor, basename, dirname } from "@/lib/paths";
import { confirm } from "@/components/ConfirmDialog";
import type { ContextMenuItem } from "@/components/ContextMenu";
import { prompt } from "@/components/PromptDialog";
import { useAssetsStore } from "@/stores/assetsStore";
import { useUndoStore } from "@/stores/undoStore";
import { loadModelThumbnailer } from "@/lib/loadModelThumbnailer";

const RENDERABLE_MODEL_EXTS = new Set(["gltf", "glb", "obj", "stl", "ply", "fbx"]);
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
export function buildAssetContextMenu(asset: Asset): ContextMenuItem[] {
	const items: ContextMenuItem[] = [
		{
			label: "Rename…",
			icon: HiPencilSquare,
			onClick: () => renameAction(asset),
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

async function refreshModelThumbnailAction(asset: Asset) {
	try {
		const thumbnailer = await loadModelThumbnailer();
		const ok = await thumbnailer.request(
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
	const defaultDir = `${asset.root_path}/${dirname(asset.relative_path) || ""}`.replace(
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
	const originalDir = `${asset.root_path}/${dirname(asset.relative_path)}`.replace(
		/\/$/,
		"",
	);

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
