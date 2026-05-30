// SPDX-License-Identifier: AGPL-3.0-or-later
//! The Music Library workflow — the interior rendered for a "music"-type
//! workspace. Reads the workspace's folder + filter scope from config, loads
//! the in-scope audio assets grouped into albums/artists, and lets the user
//! browse covers, drill into an album's tracks, and (via the PlayerBar) play
//! them. Catalog-backed: it draws from the indexed library, not an OS folder.

import { useEffect } from "react";
import { HiMusicalNote, HiSquares2X2, HiUserGroup } from "react-icons/hi2";
import type { Workspace } from "@/lib/tauri";
import { workspaceScopeQuery } from "@/lib/workspaceConfig";
import { AlbumDetailView } from "@/plugins/music/components/AlbumDetailView";
import { AlbumGrid } from "@/plugins/music/components/AlbumGrid";
import { ArtistView } from "@/plugins/music/components/ArtistView";
import { useMusicStore, useSelectedAlbum } from "@/plugins/music/stores/musicStore";

export function MusicWorkflow({ workspace }: { workspace: Workspace }) {
	const load = useMusicStore((s) => s.load);
	const loading = useMusicStore((s) => s.loading);
	const error = useMusicStore((s) => s.error);
	const library = useMusicStore((s) => s.library);
	const view = useMusicStore((s) => s.view);
	const setView = useMusicStore((s) => s.setView);
	const selectAlbum = useMusicStore((s) => s.selectAlbum);
	const selectedAlbum = useSelectedAlbum();

	// (Re)load when the workspace's scope (root folder / filters) changes.
	const scope = workspaceScopeQuery(workspace);
	const underPath = scope.underPath;
	const formatsKey = scope.formats?.join(",") ?? "";
	useEffect(() => {
		void load({ underPath, formats: formatsKey ? formatsKey.split(",") : null });
	}, [underPath, formatsKey, load]);

	const empty = !library || library.track_count === 0;

	return (
		<div className="flex-1 min-h-0 flex flex-col min-w-0">
			<header className="flex items-center gap-3 border-b border-base-300 bg-base-100 px-4 py-2.5 shrink-0">
				<div className="min-w-0 flex-1">
					<h1 className="truncate text-sm font-semibold leading-tight">{workspace.name}</h1>
					<div className="text-[11px] text-base-content/55">
						{library
							? `${library.albums.length} ${library.albums.length === 1 ? "album" : "albums"} · ${library.track_count} ${library.track_count === 1 ? "track" : "tracks"}`
							: "Music library"}
					</div>
				</div>
				{!selectedAlbum && !empty && (
					<div className="join">
						<button
							type="button"
							className={`btn btn-xs join-item gap-1 ${view === "albums" ? "btn-active" : ""}`}
							onClick={() => setView("albums")}
						>
							<HiSquares2X2 className="size-3.5" />
							Albums
						</button>
						<button
							type="button"
							className={`btn btn-xs join-item gap-1 ${view === "artists" ? "btn-active" : ""}`}
							onClick={() => setView("artists")}
						>
							<HiUserGroup className="size-3.5" />
							Artists
						</button>
					</div>
				)}
			</header>

			<div className="flex-1 min-h-0 overflow-y-auto">
				{loading ? (
					<Centered>Loading music…</Centered>
				) : error ? (
					<Centered className="text-error">{error}</Centered>
				) : empty || !library ? (
					<EmptyState hasFolder={!!underPath} />
				) : selectedAlbum ? (
					<AlbumDetailView album={selectedAlbum} onBack={() => selectAlbum(null)} />
				) : view === "albums" ? (
					<AlbumGrid albums={library.albums} onSelect={selectAlbum} />
				) : (
					<ArtistView albums={library.albums} onSelect={selectAlbum} />
				)}
			</div>
		</div>
	);
}

function Centered({ children, className = "" }: { children: React.ReactNode; className?: string }) {
	return (
		<div className={`flex h-full items-center justify-center text-sm text-base-content/60 ${className}`}>
			{children}
		</div>
	);
}

function EmptyState({ hasFolder }: { hasFolder: boolean }) {
	return (
		<div className="flex h-full flex-col items-center justify-center p-12 text-center">
			<div className="mb-5 flex size-16 items-center justify-center rounded-full border border-base-300 bg-base-100 text-base-content/40">
				<HiMusicalNote className="size-7" />
			</div>
			<h2 className="text-lg font-semibold">No music here yet</h2>
			<p className="mt-2 max-w-md text-sm text-base-content/60">
				{hasFolder
					? "No audio files were found in this workspace's folder. Make sure it's inside a registered library root and has been scanned."
					: "Register a folder of music as a library root (and scan it), or set this workspace's working folder from its right-click → Settings."}
			</p>
		</div>
	);
}
