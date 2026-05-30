// SPDX-License-Identifier: AGPL-3.0-or-later
//! Animated three-bar "now playing" equalizer indicator (uses the `.eq-bar`
//! keyframe in styles/index.css). Inherits `currentColor`.

export function PlayingBars({ className = "" }: { className?: string }) {
	return (
		<span
			className={`inline-flex h-3.5 items-end gap-[2px] ${className}`}
			aria-label="Playing"
		>
			<span
				className="eq-bar h-full w-[2px] bg-current"
				style={{ animationDelay: "0ms" }}
			/>
			<span
				className="eq-bar h-full w-[2px] bg-current"
				style={{ animationDelay: "180ms" }}
			/>
			<span
				className="eq-bar h-full w-[2px] bg-current"
				style={{ animationDelay: "360ms" }}
			/>
		</span>
	);
}
