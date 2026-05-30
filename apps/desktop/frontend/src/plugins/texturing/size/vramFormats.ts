// SPDX-License-Identifier: AGPL-3.0-or-later
/** GPU texture compression format definition */
export interface GpuFormat {
	name: string;
	description: string;
	/** Bits per pixel (for uncompressed) or effective bpp (for block-compressed) */
	bpp: number;
	/** Compute byte size for a single mip level */
	sizeBytes: (width: number, height: number) => number;
}

/** Block-compressed size: ceil(w/blockW) * ceil(h/blockH) * bytesPerBlock */
function blockSize(w: number, h: number, blockW: number, blockH: number, bytesPerBlock: number): number {
	return Math.ceil(w / blockW) * Math.ceil(h / blockH) * bytesPerBlock;
}

export const GPU_FORMATS: GpuFormat[] = [
	{
		name: "Uncompressed RGBA8",
		description: "32-bit, 4 channels",
		bpp: 32,
		sizeBytes: (w, h) => w * h * 4,
	},
	{
		name: "Uncompressed RGB8",
		description: "24-bit, 3 channels",
		bpp: 24,
		sizeBytes: (w, h) => w * h * 3,
	},
	{
		name: "BC1 / DXT1",
		description: "RGB, 1-bit alpha",
		bpp: 4,
		sizeBytes: (w, h) => blockSize(w, h, 4, 4, 8),
	},
	{
		name: "BC3 / DXT5",
		description: "RGBA, interpolated alpha",
		bpp: 8,
		sizeBytes: (w, h) => blockSize(w, h, 4, 4, 16),
	},
	{
		name: "BC4",
		description: "Single channel (grayscale)",
		bpp: 4,
		sizeBytes: (w, h) => blockSize(w, h, 4, 4, 8),
	},
	{
		name: "BC5",
		description: "Two channels (normal maps)",
		bpp: 8,
		sizeBytes: (w, h) => blockSize(w, h, 4, 4, 16),
	},
	{
		name: "BC7",
		description: "High-quality RGBA",
		bpp: 8,
		sizeBytes: (w, h) => blockSize(w, h, 4, 4, 16),
	},
	{
		name: "ASTC 4×4",
		description: "Adaptive, high quality",
		bpp: 8,
		sizeBytes: (w, h) => blockSize(w, h, 4, 4, 16),
	},
	{
		name: "ASTC 6×6",
		description: "Adaptive, balanced",
		bpp: 3.56,
		sizeBytes: (w, h) => blockSize(w, h, 6, 6, 16),
	},
	{
		name: "ASTC 8×8",
		description: "Adaptive, smallest",
		bpp: 2,
		sizeBytes: (w, h) => blockSize(w, h, 8, 8, 16),
	},
	{
		name: "ETC2 RGB",
		description: "Mobile, 3 channels",
		bpp: 4,
		sizeBytes: (w, h) => blockSize(w, h, 4, 4, 8),
	},
	{
		name: "ETC2 RGBA",
		description: "Mobile, 4 channels",
		bpp: 8,
		sizeBytes: (w, h) => blockSize(w, h, 4, 4, 16),
	},
];

/** Compute all mip level dimensions from a base resolution */
export function computeMipLevels(width: number, height: number): { width: number; height: number }[] {
	const levels: { width: number; height: number }[] = [];
	let w = width;
	let h = height;
	while (true) {
		levels.push({ width: w, height: h });
		if (w === 1 && h === 1) break;
		w = Math.max(1, Math.floor(w / 2));
		h = Math.max(1, Math.floor(h / 2));
	}
	return levels;
}

/** Compute total byte size for a format across all mip levels */
export function computeTotalWithMips(format: GpuFormat, width: number, height: number): number {
	const levels = computeMipLevels(width, height);
	return levels.reduce((sum, lvl) => sum + format.sizeBytes(lvl.width, lvl.height), 0);
}

/** Format a byte count as a human-readable string */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
