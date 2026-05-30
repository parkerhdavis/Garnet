// SPDX-License-Identifier: AGPL-3.0-or-later
import { usePackStore } from "@/plugins/texturing/stores/packStore";
import DropZone from "@/plugins/texturing/ui/DropZone";
import type { ChannelSource } from "@/plugins/texturing/types";


const channelRows = [
	{ key: "r" as const, label: "R", dotColor: "bg-red-500" },
	{ key: "g" as const, label: "G", dotColor: "bg-green-500" },
	{ key: "b" as const, label: "B", dotColor: "bg-blue-500" },
	{ key: "a" as const, label: "A", dotColor: "bg-base-content/30" },
];

const sourceOptions: { value: ChannelSource; label: string }[] = [
	{ value: "r", label: "Red" },
	{ value: "g", label: "Green" },
	{ value: "b", label: "Blue" },
	{ value: "a", label: "Alpha" },
	{ value: "luminance", label: "Luminance" },
];

export default function SwizzlePanel() {
	const {
		swizzleInputPath,
		swizzleInputPreview,
		swizzleMappings,
		swizzleInputLoading,
		loadSwizzleInput,
		clearSwizzleInput,
		setSwizzleMapping,
		toggleSwizzleInvert,
	} = usePackStore();

	return (
		<>
			{/* Header */}
			<div className="px-3 pt-3 pb-2 border-b border-base-300 shrink-0">
				<div className="text-sm font-semibold text-base-content">Swizzle</div>
				<div className="text-xs text-base-content/40 mt-0.5 leading-snug">
					Remap channels within a single image. Each output channel can read from any source channel, with optional invert.
				</div>
			</div>

			{/* Input */}
			<div className="p-3 border-b border-base-300">
				<label className="text-xs font-semibold text-base-content/50 mb-1 block">
					Input Image
				</label>
				<DropZone
					label="Drop image"
					filePath={swizzleInputPath}
					thumbnail={swizzleInputPreview}
					onFilePicked={loadSwizzleInput}
					onClear={clearSwizzleInput}
					loading={swizzleInputLoading}
					compact
				/>
			</div>

			{/* Channel mapping */}
			<div className="p-3 space-y-2">
				<label className="text-xs font-semibold text-base-content/50 block">
					Channel Mapping
				</label>
				{channelRows.map((ch) => (
					<div key={ch.key} className="flex items-center gap-2">
						<span className={`size-2.5 rounded-full ${ch.dotColor} shrink-0`} />
						<span className="text-xs font-bold w-4 shrink-0">{ch.label}</span>
						<select
							value={swizzleMappings[ch.key].source}
							onChange={(e) => setSwizzleMapping(ch.key, e.target.value as ChannelSource)}
							className="select select-xs select-bordered flex-1"
						>
							{sourceOptions.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
						<label className="flex items-center gap-1.5 cursor-pointer">
							<input
								type="checkbox"
								checked={swizzleMappings[ch.key].invert}
								onChange={() => toggleSwizzleInvert(ch.key)}
								className="checkbox checkbox-xs checkbox-primary"
							/>
							<span className="text-xs text-base-content/50">Invert</span>
						</label>
					</div>
				))}
			</div>
		</>
	);
}
