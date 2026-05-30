// SPDX-License-Identifier: AGPL-3.0-or-later
//! Gold "Hi-Res" badge shown for high-resolution audio (≥24-bit or >48 kHz).

export function HiResBadge({ className = "" }: { className?: string }) {
	return (
		<span
			className={`badge badge-sm border border-amber-500/30 bg-amber-400/15 font-semibold text-amber-500 ${className}`}
			title="High-resolution audio"
		>
			Hi-Res
		</span>
	);
}
