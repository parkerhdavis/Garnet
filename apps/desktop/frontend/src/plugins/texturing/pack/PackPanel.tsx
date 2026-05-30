// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { usePackStore } from "@/plugins/texturing/stores/packStore";
import ChannelSlotCard from "@/plugins/texturing/pack/ChannelSlotCard";
import { LuWand } from "react-icons/lu";

export default function PackPanel() {
	const {
		packPresets,
		packActivePreset,
		packPresetLabels,
		loadPresets,
		applyPreset,
		clearPreset,
		autoDetectChannels,
	} = usePackStore();

	const handleAutoDetect = useCallback(async () => {
		if (!packPresetLabels) return;
		try {
			const dir = await open({ directory: true });
			if (typeof dir !== "string") return;
			const files = await invoke<string[]>("list_image_files", { dir });
			await autoDetectChannels(files);
		} catch (err) {
			console.error(`Auto-detect failed: ${err}`);
		}
	}, [packPresetLabels, autoDetectChannels]);

	useEffect(() => {
		loadPresets();
	}, [loadPresets]);

	return (
		<>
			{/* Header */}
			<div className="px-3 pt-3 pb-2 border-b border-base-300 shrink-0">
				<div className="text-sm font-semibold text-base-content">Pack</div>
				<div className="text-xs text-base-content/40 mt-0.5 leading-snug">
					Combine separate grayscale textures into a single RGBA image. Use
					presets for common engine formats.
				</div>
			</div>

			<div className="p-3 space-y-2">
				{/* Preset selector */}
				<div className="flex gap-2 items-center">
					<select
						value={packActivePreset ?? ""}
						onChange={(e) => {
							const val = e.target.value;
							if (val) applyPreset(val);
							else clearPreset();
						}}
						className="select select-xs select-bordered flex-1"
					>
						<option value="">No preset</option>
						{packPresets.map((p) => (
							<option key={p.name} value={p.name}>
								{p.name}
							</option>
						))}
					</select>
					<button
						type="button"
						onClick={handleAutoDetect}
						disabled={!packPresetLabels}
						className="btn btn-xs btn-ghost h-6 min-h-0 px-2 gap-1"
						title={
							!packPresetLabels
								? "Select a preset first"
								: "Auto-detect textures from a directory"
						}
					>
						<LuWand size={12} />
						<span>Auto</span>
					</button>
				</div>

				{/* Channel slots */}
				<ChannelSlotCard slot="r" label={packPresetLabels?.r} />
				<ChannelSlotCard slot="g" label={packPresetLabels?.g} />
				<ChannelSlotCard slot="b" label={packPresetLabels?.b} />
				<ChannelSlotCard slot="a" label={packPresetLabels?.a} />
			</div>
		</>
	);
}
