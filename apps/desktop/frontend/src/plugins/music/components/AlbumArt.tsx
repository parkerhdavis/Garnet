// SPDX-License-Identifier: AGPL-3.0-or-later
//! Album cover image. Resolves art via the backend (embedded → folder cover),
//! caching results module-wide so the same cover isn't re-fetched across
//! re-renders/remounts. Shows a music-note placeholder while loading or when no
//! art exists.

import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { HiMusicalNote } from "react-icons/hi2";
import { api } from "@/lib/tauri";

/// absPath → resolved <img src> ("" = no art found). Shared across instances.
const srcCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function resolveArt(absPath: string, size: number): Promise<string> {
	const cached = srcCache.get(absPath);
	if (cached !== undefined) return Promise.resolve(cached);
	let p = inflight.get(absPath);
	if (!p) {
		p = api
			.loadAlbumArt(absPath, null, size)
			.then((path) => (path ? convertFileSrc(path) : ""))
			.catch(() => "")
			.then((src) => {
				srcCache.set(absPath, src);
				inflight.delete(absPath);
				return src;
			});
		inflight.set(absPath, p);
	}
	return p;
}

export function AlbumArt({
	absPath,
	size = 300,
	className = "",
	rounded = "rounded-md",
}: {
	absPath: string;
	/// Pixel size requested from the backend (cover is downscaled to fit).
	size?: number;
	className?: string;
	rounded?: string;
}) {
	const [src, setSrc] = useState<string>(() => srcCache.get(absPath) ?? "");
	const [resolved, setResolved] = useState<boolean>(() => srcCache.has(absPath));

	useEffect(() => {
		let cancelled = false;
		if (srcCache.has(absPath)) {
			setSrc(srcCache.get(absPath) ?? "");
			setResolved(true);
			return;
		}
		setResolved(false);
		void resolveArt(absPath, size).then((s) => {
			if (cancelled) return;
			setSrc(s);
			setResolved(true);
		});
		return () => {
			cancelled = true;
		};
	}, [absPath, size]);

	if (src) {
		return (
			<img
				src={src}
				alt=""
				loading="lazy"
				className={`${className} ${rounded} object-cover bg-base-300`}
			/>
		);
	}
	return (
		<div
			className={`${className} ${rounded} bg-base-300 flex items-center justify-center text-base-content/25`}
			aria-busy={!resolved}
		>
			<HiMusicalNote className="size-1/3" />
		</div>
	);
}
