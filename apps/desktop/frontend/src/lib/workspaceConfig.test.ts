// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, test, expect } from "bun:test";
import type { Workspace } from "./tauri";
import { parseFileFilters, workspaceScopeQuery } from "./workspaceConfig";

function ws(config: Record<string, unknown>): Workspace {
	return {
		id: 1,
		name: "w",
		type: "music",
		icon: null,
		config,
		sort_order: 0,
		created_at: 0,
	};
}

describe("workspaceScopeQuery", () => {
	test("empty config means whole library (nulls)", () => {
		const s = workspaceScopeQuery(ws({}));
		expect(s.underPath).toBeNull();
		expect(s.formats).toBeNull();
	});

	test("maps rootFolder → underPath and fileFilters → formats", () => {
		const s = workspaceScopeQuery(ws({ rootFolder: "/music", fileFilters: "mp3, flac" }));
		expect(s.underPath).toBe("/music");
		expect(s.formats).toEqual(["mp3", "flac"]);
	});

	test("blank filters parse to null formats", () => {
		const s = workspaceScopeQuery(ws({ rootFolder: "/m", fileFilters: "   " }));
		expect(s.underPath).toBe("/m");
		expect(s.formats).toBeNull();
	});
});

describe("parseFileFilters", () => {
	test("null / empty input means 'all images'", () => {
		expect(parseFileFilters(null)).toBeNull();
		expect(parseFileFilters("")).toBeNull();
		expect(parseFileFilters("   ")).toBeNull();
	});

	test("splits on commas/whitespace, lowercases, strips leading dots", () => {
		expect(parseFileFilters("png, tga, exr")).toEqual(["png", "tga", "exr"]);
		expect(parseFileFilters("PNG  TGA")).toEqual(["png", "tga"]);
		expect(parseFileFilters(".PNG,.Tga")).toEqual(["png", "tga"]);
	});

	test("collapses stray separators into no empty entries", () => {
		expect(parseFileFilters(",png,,  ,tga ")).toEqual(["png", "tga"]);
	});
});
