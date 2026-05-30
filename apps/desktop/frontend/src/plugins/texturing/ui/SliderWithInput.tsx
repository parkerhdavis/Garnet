// SPDX-License-Identifier: AGPL-3.0-or-later
//! Labeled slider + numeric input, kept in sync. Ported from Packi.

interface SliderWithInputProps {
	label: string;
	value: number;
	onChange: (value: number) => void;
	min: number;
	max: number;
	step: number;
	/** Unit suffix shown after the value in the label (e.g. "°"). */
	unit?: string;
	decimals?: number;
	showSign?: boolean;
	rangeLabels?: string[];
}

export default function SliderWithInput({
	label,
	value,
	onChange,
	min,
	max,
	step,
	unit = "",
	decimals = 1,
	showSign = false,
	rangeLabels,
}: SliderWithInputProps) {
	const displayValue = value.toFixed(decimals);
	const sign = showSign && value > 0 ? "+" : "";

	return (
		<div>
			<label className="text-xs font-semibold text-base-content/50 mb-1 block">
				{label}: {sign}
				{displayValue}
				{unit}
			</label>
			<div className="flex items-center gap-2">
				<input
					type="range"
					min={min}
					max={max}
					step={step}
					value={value}
					onChange={(e) => onChange(Number.parseFloat(e.target.value))}
					className="range range-primary range-xs flex-1"
				/>
				<input
					type="number"
					min={min}
					max={max}
					step={step}
					value={displayValue}
					onChange={(e) => {
						const v = Number.parseFloat(e.target.value);
						if (!Number.isNaN(v)) onChange(Math.min(max, Math.max(min, v)));
					}}
					className="input input-xs input-bordered w-16 text-right tabular-nums font-mono text-xs"
				/>
			</div>
			{rangeLabels && (
				<div className="flex justify-between text-xs text-base-content/30 mt-0.5">
					{rangeLabels.map((lbl) => (
						<span key={lbl}>{lbl}</span>
					))}
				</div>
			)}
		</div>
	);
}
