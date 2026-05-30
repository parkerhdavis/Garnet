// SPDX-License-Identifier: AGPL-3.0-or-later
import { usePackStore } from "@/plugins/texturing/stores/packStore";
import DropZone from "@/plugins/texturing/ui/DropZone";

export default function UnpackPanel() {
	const {
		unpackInputPath,
		unpackInputPreview,
		unpackLoading,
		loadUnpackInput,
		clearUnpackInput,
	} = usePackStore();

	return (
		<>
			{/* Header */}
			<div className="px-3 pt-3 pb-2 border-b border-base-300 shrink-0">
				<div className="text-sm font-semibold text-base-content">Unpack</div>
				<div className="text-xs text-base-content/40 mt-0.5 leading-snug">
					Load a packed RGBA texture and extract each channel as a separate
					grayscale image.
				</div>
			</div>

			{/* Input */}
			<div className="p-3">
				<label className="text-xs font-semibold text-base-content/50 mb-1 block">
					Packed Texture
				</label>
				<DropZone
					label="Drop packed texture"
					filePath={unpackInputPath}
					thumbnail={unpackInputPreview}
					onFilePicked={loadUnpackInput}
					onClear={clearUnpackInput}
					loading={unpackLoading}
					compact
				/>
			</div>
		</>
	);
}
