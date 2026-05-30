// SPDX-License-Identifier: AGPL-3.0-or-later
//! Export controls (format + directory + filename) shared by the Pack and
//! Normal tools. Ported from Packi, minus its settings-store persistence —
//! the chosen directory lives in component state for the session.

import { useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { HiFolderOpen, HiArrowDownTray } from "react-icons/hi2";
import type { ExportConfig, ExportFormat } from "@/plugins/texturing/types";

const formatLabels: Record<ExportFormat, string> = {
	png8: "PNG (8-bit)",
	png16: "PNG (16-bit)",
	tga: "TGA",
	jpeg: "JPEG",
	exr: "OpenEXR",
};

interface ExportPanelProps {
	formats: ExportFormat[];
	defaultFormat?: ExportFormat;
	onExport: (config: ExportConfig) => Promise<void>;
	disabled?: boolean;
	filenameDefault?: string;
}

export default function ExportPanel({
	formats,
	defaultFormat,
	onExport,
	disabled = false,
	filenameDefault = "output",
}: ExportPanelProps) {
	const [format, setFormat] = useState<ExportFormat>(defaultFormat ?? formats[0]);
	const [directory, setDirectory] = useState("");
	const [filename, setFilename] = useState(filenameDefault);
	const [exporting, setExporting] = useState(false);

	const handlePickDir = useCallback(async () => {
		const result = await open({ directory: true, defaultPath: directory || undefined });
		if (typeof result === "string") setDirectory(result);
	}, [directory]);

	const handleExport = useCallback(async () => {
		if (!directory || !filename) return;
		setExporting(true);
		try {
			await onExport({ format, directory, filename });
		} finally {
			setExporting(false);
		}
	}, [format, directory, filename, onExport]);

	return (
		<div className="flex flex-col gap-2 p-3 rounded-lg bg-base-200 border border-base-300">
			<div className="text-xs font-semibold text-base-content/50 uppercase tracking-wider">
				Export
			</div>

			<select
				value={format}
				onChange={(e) => setFormat(e.target.value as ExportFormat)}
				className="select select-xs select-bordered w-full"
			>
				{formats.map((f) => (
					<option key={f} value={f}>
						{formatLabels[f]}
					</option>
				))}
			</select>

			<div className="flex gap-1">
				<input
					type="text"
					value={directory}
					onChange={(e) => setDirectory(e.target.value)}
					placeholder="Output directory…"
					className="input input-xs input-bordered flex-1 font-mono text-xs"
					readOnly
				/>
				<button
					type="button"
					onClick={handlePickDir}
					className="btn btn-xs btn-ghost px-1.5"
					title="Browse for output directory"
				>
					<HiFolderOpen className="size-3.5" />
				</button>
			</div>

			<input
				type="text"
				value={filename}
				onChange={(e) => setFilename(e.target.value)}
				placeholder="Filename…"
				className="input input-xs input-bordered font-mono text-xs"
			/>

			<button
				type="button"
				onClick={handleExport}
				disabled={disabled || exporting || !directory || !filename}
				className="btn btn-primary btn-sm"
			>
				{exporting ? (
					<span className="loading loading-spinner loading-xs" />
				) : (
					<HiArrowDownTray className="size-3.5" />
				)}
				{exporting ? "Exporting…" : "Export"}
			</button>
		</div>
	);
}
