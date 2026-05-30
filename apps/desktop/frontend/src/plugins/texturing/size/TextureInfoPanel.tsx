// SPDX-License-Identifier: AGPL-3.0-or-later
import { useSizeStore } from "@/plugins/texturing/stores/sizeStore";
import TexturePreview from "@/plugins/texturing/ui/TexturePreview";
import { formatBytes } from "@/plugins/texturing/size/vramFormats";

function gcd(a: number, b: number): number {
	while (b) {
		[a, b] = [b, a % b];
	}
	return a;
}

function aspectLabel(w: number, h: number): string {
	const d = gcd(w, h);
	return `${w / d}:${h / d}`;
}

export default function TextureInfoPanel() {
	const info = useSizeStore((s) => s.inputInfo);
	const preview = useSizeStore((s) => s.inputPreview);

	if (!info) {
		return (
			<div className="flex-1 flex items-center justify-center text-base-content/30 text-sm">
				Load an image to view its properties.
			</div>
		);
	}

	const uncompressedBytes =
		info.width * info.height * info.channels * (info.bit_depth / 8);
	const megapixels = (info.width * info.height) / 1_000_000;
	const isPowerOfTwo = (n: number) => n > 0 && (n & (n - 1)) === 0;
	const pot = isPowerOfTwo(info.width) && isPowerOfTwo(info.height);

	const rows: { label: string; value: string }[] = [
		{ label: "Resolution", value: `${info.width} × ${info.height}` },
		{ label: "Megapixels", value: `${megapixels.toFixed(2)} MP` },
		{ label: "Aspect Ratio", value: aspectLabel(info.width, info.height) },
		{ label: "Power of Two", value: pot ? "Yes" : "No" },
		{ label: "Channels", value: `${info.channels}` },
		{ label: "Bit Depth", value: `${info.bit_depth}-bit` },
		{ label: "Format", value: info.format },
		{ label: "File Size", value: formatBytes(info.file_size) },
		{ label: "Uncompressed", value: formatBytes(uncompressedBytes) },
	];

	return (
		<div className="flex-1 min-w-0 flex">
			{/* Info table */}
			<div className="w-72 shrink-0 border-r border-base-300 p-4">
				<div className="text-sm font-semibold text-base-content mb-3">
					Image Properties
				</div>
				<table className="w-full">
					<tbody>
						{rows.map((row) => (
							<tr
								key={row.label}
								className="border-b border-base-300/50 last:border-0"
							>
								<td className="py-1.5 text-xs text-base-content/50 pr-3">
									{row.label}
								</td>
								<td className="py-1.5 text-sm font-mono text-base-content/80 text-right">
									{row.value}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{/* Preview */}
			<TexturePreview imageData={preview} imageInfo={info} className="flex-1" />
		</div>
	);
}
