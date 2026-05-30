// SPDX-License-Identifier: AGPL-3.0-or-later
//! The base Automations steps (Convert / Resize / Rename), contributed by the
//! built-in `core` plugin through the same mechanism plugins use. Each exposes
//! default params + a small params editor; the executor for these lives in the
//! Rust `automations` module.

import { HiArrowsRightLeft, HiArrowsPointingIn, HiPencilSquare } from "react-icons/hi2";
import type { AutomationStepContribution } from "@/plugins/types";

const convertStep: AutomationStepContribution = {
	type: "convert",
	label: "Convert Format",
	description: "Change the output image format.",
	icon: HiArrowsRightLeft,
	group: "base",
	defaultParams: () => ({ format: "png8", bit_depth: 8 }),
	ParamsEditor: ({ params, onChange }) => (
		<select
			value={(params.format as string) ?? "png8"}
			onChange={(e) => {
				const format = e.target.value;
				onChange({ format, bit_depth: format === "png16" ? 16 : 8 });
			}}
			className="select select-xs select-bordered w-full"
		>
			<option value="png8">PNG (8-bit)</option>
			<option value="png16">PNG (16-bit)</option>
			<option value="tga">TGA</option>
			<option value="jpeg">JPEG</option>
			<option value="exr">OpenEXR</option>
		</select>
	),
};

const resizeStep: AutomationStepContribution = {
	type: "resize",
	label: "Resize",
	description: "Scale by percentage, exact size, or nearest power of two.",
	icon: HiArrowsPointingIn,
	group: "base",
	defaultParams: () => ({ mode: "scale", width: 50, height: 50, filter: "lanczos" }),
	ParamsEditor: ({ params, onChange }) => {
		const mode = (params.mode as string) ?? "scale";
		return (
			<div className="space-y-1">
				<select
					value={mode}
					onChange={(e) => onChange({ ...params, mode: e.target.value })}
					className="select select-xs select-bordered w-full"
				>
					<option value="scale">Scale %</option>
					<option value="exact">Exact Size</option>
					<option value="nearest-pot">Nearest Power of 2</option>
				</select>
				{mode === "exact" && (
					<div className="flex gap-1 items-center">
						<input
							type="number"
							value={(params.width as number) ?? 1024}
							onChange={(e) => onChange({ ...params, width: Number(e.target.value) })}
							className="input input-xs input-bordered w-20"
							placeholder="W"
						/>
						<span className="text-xs">×</span>
						<input
							type="number"
							value={(params.height as number) ?? 1024}
							onChange={(e) => onChange({ ...params, height: Number(e.target.value) })}
							className="input input-xs input-bordered w-20"
							placeholder="H"
						/>
					</div>
				)}
				{mode === "scale" && (
					<input
						type="number"
						value={(params.width as number) ?? 50}
						onChange={(e) => {
							const v = Number(e.target.value);
							onChange({ ...params, width: v, height: v });
						}}
						className="input input-xs input-bordered w-full"
						placeholder="Scale %"
					/>
				)}
			</div>
		);
	},
};

const renameStep: AutomationStepContribution = {
	type: "rename",
	label: "Rename",
	description: "Pattern-based rename with {name} {index} {ext} tokens.",
	icon: HiPencilSquare,
	group: "base",
	defaultParams: () => ({ pattern: "{name}" }),
	ParamsEditor: ({ params, onChange }) => (
		<div>
			<input
				type="text"
				value={(params.pattern as string) ?? "{name}"}
				onChange={(e) => onChange({ ...params, pattern: e.target.value })}
				className="input input-xs input-bordered w-full font-mono"
			/>
			<p className="text-[10px] text-base-content/40 mt-0.5">
				{"{name}"} {"{index}"} {"{ext}"}
			</p>
		</div>
	),
};

export const coreAutomationSteps: AutomationStepContribution[] = [
	convertStep,
	resizeStep,
	renameStep,
];
