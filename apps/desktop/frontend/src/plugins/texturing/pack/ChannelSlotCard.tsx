// SPDX-License-Identifier: AGPL-3.0-or-later
import { usePackStore } from "@/plugins/texturing/stores/packStore";
import type { ChannelSource } from "@/plugins/texturing/types";
import DropZone from "@/plugins/texturing/ui/DropZone";

const channelColors: Record<string, string> = {
	r: "border-red-500",
	g: "border-green-500",
	b: "border-blue-500",
	a: "border-base-content/30",
};

const channelNames: Record<string, string> = {
	r: "R",
	g: "G",
	b: "B",
	a: "A",
};

const sourceOptions: { value: ChannelSource; label: string }[] = [
	{ value: "luminance", label: "Luminance" },
	{ value: "r", label: "Red" },
	{ value: "g", label: "Green" },
	{ value: "b", label: "Blue" },
	{ value: "a", label: "Alpha" },
];

interface ChannelSlotCardProps {
	slot: "r" | "g" | "b" | "a";
	label?: string;
}

export default function ChannelSlotCard({ slot, label }: ChannelSlotCardProps) {
	const channel = usePackStore((s) => s.packChannels[slot]);
	const loading = usePackStore((s) => s.packLoadingChannels[slot]);
	const setChannel = usePackStore((s) => s.setChannel);
	const clearChannel = usePackStore((s) => s.clearChannel);
	const setSourceChannel = usePackStore((s) => s.setSourceChannel);
	const toggleInvert = usePackStore((s) => s.toggleInvert);

	const displayLabel = label ?? channelNames[slot];

	return (
		<div
			className={`rounded-lg bg-base-100 border-l-4 ${channelColors[slot]} p-3`}
		>
			<div className="flex items-center gap-2 mb-2">
				<span className="text-sm font-bold">{channelNames[slot]}</span>
				{label && <span className="text-xs text-base-content/50">{label}</span>}
			</div>

			<DropZone
				label={`Drop ${displayLabel} texture`}
				filePath={channel?.filePath ?? null}
				thumbnail={channel?.thumbnail ?? null}
				onFilePicked={(path) => setChannel(slot, path)}
				onClear={() => clearChannel(slot)}
				loading={loading}
				compact
			/>

			{channel && (
				<div className="flex items-center gap-2 mt-2">
					<select
						value={channel.sourceChannel}
						onChange={(e) =>
							setSourceChannel(slot, e.target.value as ChannelSource)
						}
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
							checked={channel.invert}
							onChange={() => toggleInvert(slot)}
							className="checkbox checkbox-xs checkbox-primary"
						/>
						<span className="text-xs text-base-content/50">Invert</span>
					</label>

					<span className="text-xs text-base-content/40">
						{channel.info.width}x{channel.info.height}
					</span>
				</div>
			)}
		</div>
	);
}
