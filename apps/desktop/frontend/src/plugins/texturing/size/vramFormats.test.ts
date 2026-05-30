// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, test, expect } from "bun:test";
import {
	GPU_FORMATS,
	computeMipLevels,
	computeTotalWithMips,
	formatBytes,
} from "./vramFormats";

describe("computeMipLevels", () => {
	test("halves each axis down to 1×1 (square)", () => {
		expect(computeMipLevels(4, 4)).toEqual([
			{ width: 4, height: 4 },
			{ width: 2, height: 2 },
			{ width: 1, height: 1 },
		]);
	});

	test("halves axes independently (non-square)", () => {
		expect(computeMipLevels(8, 4)).toEqual([
			{ width: 8, height: 4 },
			{ width: 4, height: 2 },
			{ width: 2, height: 1 },
			{ width: 1, height: 1 },
		]);
	});

	test("1×1 is a single level", () => {
		expect(computeMipLevels(1, 1)).toHaveLength(1);
	});
});

describe("formatBytes", () => {
	test("scales by unit", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2.0 KB");
		expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
	});
});

describe("GPU_FORMATS", () => {
	test("every format has a positive size, and mips add cost", () => {
		expect(GPU_FORMATS.length).toBeGreaterThan(0);
		for (const fmt of GPU_FORMATS) {
			const base = fmt.sizeBytes(256, 256);
			expect(base).toBeGreaterThan(0);
			// Including the mip chain is always strictly more than the base level.
			expect(computeTotalWithMips(fmt, 256, 256)).toBeGreaterThan(base);
		}
	});
});
