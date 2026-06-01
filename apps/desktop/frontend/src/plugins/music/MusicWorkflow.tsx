// SPDX-License-Identifier: AGPL-3.0-or-later
//! The Music Library workflow — the interior rendered for a "music"-type
//! workspace. Reads the workspace's folder + filter scope from config, loads
//! the in-scope audio assets grouped into albums/artists, and lets the user
//! browse covers, filter to an artist, search, drill into an album's tracks,
//! and (via the global player) play them. Catalog-backed: it draws from the
//! indexed library, not an OS folder.

import { useEffect, useMemo, useState } from "react";
import {
	HiChevronLeft,
	HiMagnifyingGlass,
	HiMusicalNote,
	HiSquares2X2,
	HiUserGroup,
	HiXMark,
} from "react-icons/hi2";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type MusicAlbum, type Workspace } from "@/lib/tauri";
import { workspaceScopeQuery } from "@/lib/workspaceConfig";
import { AlbumDetailView } from "@/plugins/music/components/AlbumDetailView";
import { AlbumGrid } from "@/plugins/music/components/AlbumGrid";
import { ArtistView } from "@/plugins/music/components/ArtistView";
import { useMusicStore } from "@/plugins/music/stores/musicStore";

export function MusicWorkflow({ workspace }: { workspace: Workspace }) {
	const load = useMusicStore((s) => s.load);
	const loading = useMusicStore((s) => s.loading);
	const error = useMusicStore((s) => s.error);
	const library = useMusicStore((s) => s.library);
	const view = useMusicStore((s) => s.view);
	const setView = useMusicStore((s) => s.setView);
	const setActiveWorkspace = useMusicStore((s) => s.setActiveWorkspace);

	// Record this as the active music workspace so playback started here is
	// attributed to it — the global player bar navigates back to it on click.
	useEffect(() => {
		setActiveWorkspace(workspace.id);
	}, [workspace.id, setActiveWorkspace]);

	// Browse navigation lives in the URL (?album / ?artist) so the back gesture
	// pops album → artist → grid (instead of leaving the workspace) and the
	// spot is restorable. Search is transient local state (not history).
	const [searchParams, setSearchParams] = useSearchParams();
	const navigate = useNavigate();
	const [search, setSearch] = useState("");

	const selectedAlbumId = searchParams.get("album");
	const artistFilter = searchParams.get("artist");

	const setParam = (mutate: (p: URLSearchParams) => void) => {
		const next = new URLSearchParams(searchParams);
		mutate(next);
		setSearchParams(next);
	};
	const openAlbum = (id: string) => setParam((p) => p.set("album", id));
	const openArtist = (artist: string) =>
		setParam((p) => {
			p.set("artist", artist);
			p.delete("album");
		});
	const goBack = () => navigate(-1);

	// (Re)load when the workspace's scope (root folder / filters) changes.
	const scope = workspaceScopeQuery(workspace);
	const underPath = scope.underPath;
	const formatsKey = scope.formats?.join(",") ?? "";
	useEffect(() => {
		void load({
			underPath,
			formats: formatsKey ? formatsKey.split(",") : null,
		});
	}, [underPath, formatsKey, load]);

	// Warm the waveform-peaks cache in the background once the library loads, so
	// first-play of any track is instant (the backend skips already-cached ones).
	useEffect(() => {
		if (!library) return;
		const paths = library.albums.flatMap((a) =>
			a.tracks.map((t) => t.abs_path),
		);
		if (paths.length > 0) void api.prewarmPeaks(paths);
	}, [library]);

	const selectedAlbum =
		selectedAlbumId && library
			? (library.albums.find((a) => a.id === selectedAlbumId) ?? null)
			: null;

	// Albums after artist filter + search (used by the grid views).
	const q = search.trim().toLowerCase();
	const filteredAlbums = useMemo(() => {
		if (!library) return [];
		let albums = library.albums;
		if (artistFilter)
			albums = albums.filter((a) => a.album_artist === artistFilter);
		if (q) {
			albums = albums.filter(
				(a) =>
					a.album.toLowerCase().includes(q) ||
					a.album_artist.toLowerCase().includes(q) ||
					a.tracks.some((t) => t.title.toLowerCase().includes(q)),
			);
		}
		return albums;
	}, [library, artistFilter, q]);

	const empty = !library || library.track_count === 0;
	const browsing = !selectedAlbum && !empty;
	const filtering = !!artistFilter || q.length > 0;

	return (
		<div className="flex-1 min-h-0 flex flex-col min-w-0">
			<header className="flex items-center gap-3 border-b border-base-300 bg-base-100 px-4 py-2.5 shrink-0">
				<div className="min-w-0 flex-1">
					<h1 className="truncate text-sm font-semibold leading-tight">
						{workspace.name}
					</h1>
					<div className="text-[11px] text-base-content/55">
						{library
							? `${library.albums.length} ${library.albums.length === 1 ? "album" : "albums"} · ${library.track_count} ${library.track_count === 1 ? "track" : "tracks"}`
							: "Music library"}
					</div>
				</div>

				{browsing && (
					<>
						<label className="input input-xs input-bordered flex w-48 items-center gap-1.5">
							<HiMagnifyingGlass className="size-3.5 shrink-0 text-base-content/50" />
							<input
								type="text"
								placeholder="Search…"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								className="grow"
							/>
							{search && (
								<button
									type="button"
									onClick={() => setSearch("")}
									title="Clear"
								>
									<HiXMark className="size-3.5 text-base-content/50" />
								</button>
							)}
						</label>
						{artistFilter ? (
							<button
								type="button"
								className="btn btn-xs gap-1"
								onClick={goBack}
							>
								<HiChevronLeft className="size-3.5" />
								All
							</button>
						) : (
							!q && (
								<div className="join">
									<button
										type="button"
										className={`btn btn-xs join-item gap-1 ${view === "albums" ? "btn-primary" : ""}`}
										onClick={() => setView("albums")}
									>
										<HiSquares2X2 className="size-3.5" />
										Albums
									</button>
									<button
										type="button"
										className={`btn btn-xs join-item gap-1 ${view === "artists" ? "btn-primary" : ""}`}
										onClick={() => setView("artists")}
									>
										<HiUserGroup className="size-3.5" />
										Artists
									</button>
								</div>
							)
						)}
					</>
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
					<AlbumDetailView
						album={selectedAlbum}
						onBack={goBack}
						onArtist={openArtist}
					/>
				) : filtering ? (
					<FilteredAlbums
						albums={filteredAlbums}
						artist={artistFilter}
						query={q}
						onSelect={openAlbum}
						onArtist={openArtist}
					/>
				) : view === "albums" ? (
					<AlbumGrid
						albums={library.albums}
						onSelect={openAlbum}
						onArtist={openArtist}
					/>
				) : (
					<ArtistView
						albums={library.albums}
						onSelect={openAlbum}
						onArtist={openArtist}
					/>
				)}
			</div>
		</div>
	);
}

/// Grid of albums narrowed by an artist filter and/or a search query, with a
/// heading describing the active filter.
function FilteredAlbums({
	albums,
	artist,
	query,
	onSelect,
	onArtist,
}: {
	albums: MusicAlbum[];
	artist: string | null;
	query: string;
	onSelect: (id: string) => void;
	onArtist: (artist: string) => void;
}) {
	const heading = artist
		? artist
		: `Results for “${query}” (${albums.length} ${albums.length === 1 ? "album" : "albums"})`;
	return (
		<div>
			<div className="px-4 pt-4 pb-1">
				<h2 className="truncate text-lg font-semibold">{heading}</h2>
			</div>
			{albums.length > 0 ? (
				<AlbumGrid albums={albums} onSelect={onSelect} onArtist={onArtist} />
			) : (
				<div className="px-4 py-10 text-center text-sm text-base-content/50">
					No matches.
				</div>
			)}
		</div>
	);
}

function Centered({
	children,
	className = "",
}: { children: React.ReactNode; className?: string }) {
	return (
		<div
			className={`flex h-full items-center justify-center text-sm text-base-content/60 ${className}`}
		>
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
