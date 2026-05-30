// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, test, expect } from "bun:test";
import { parseFileFilters } from "./workspaceConfig";

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
