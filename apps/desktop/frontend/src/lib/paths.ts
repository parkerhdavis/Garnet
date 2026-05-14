// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Asset } from "@/lib/tauri";

/// Join an asset's root path with its relative path. Tauri canonicalizes
/// `library_roots.path` with no trailing slash, and forward slashes are
/// accepted by Windows too, so a literal "/" join is portable enough for
/// our purposes (display, thumbnail lookup, convertFileSrc).
export function absPathFor(asset: Asset): string {
	return `${asset.root_path}/${asset.relative_path}`;
}

export function basename(p: string): string {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i === -1 ? p : p.slice(i + 1);
}

export function abbreviatePath(p: string): string {
	const parts = p.split("/").filter(Boolean);
	if (parts.length <= 2) return p;
	return `…/${parts.slice(-2).join("/")}`;
}

export function formatSize(bytes: number | null): string {
	if (bytes === null) return "—";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let n = bytes;
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i += 1;
	}
	return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function formatTime(unix: number | null): string {
	if (unix === null) return "—";
	return new Date(unix * 1000).toLocaleString();
}
