// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from "bun:test";
import type { MusicAlbum } from "@/lib/tauri";
import { groupAlbumsByArtist } from "./grouping";

function album(id: string, artist: string, tracks: number): MusicAlbum {
	return {
		id,
		album: id,
		album_artist: artist,
		year: null,
		track_count: tracks,
		total_duration_secs: 0,
		cover_asset_id: 0,
		cover_abs_path: "",
		tracks: [],
	};
}

describe("groupAlbumsByArtist", () => {
	test("groups albums by album_artist, preserving order", () => {
		const groups = groupAlbumsByArtist([
			album("a1", "Alpha", 10),
			album("a2", "Alpha", 5),
			album("b1", "Beta", 8),
		]);
		expect(groups).toHaveLength(2);
		expect(groups[0].artist).toBe("Alpha");
		expect(groups[0].albumCount).toBe(2);
		expect(groups[0].trackCount).toBe(15);
		expect(groups[1].artist).toBe("Beta");
		expect(groups[1].albumCount).toBe(1);
	});

	test("empty input yields no groups", () => {
		expect(groupAlbumsByArtist([])).toEqual([]);
	});
});
