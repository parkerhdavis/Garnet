// SPDX-License-Identifier: AGPL-3.0-or-later
//! The up-next queue, shown floating above the player bar. Lists the current
//! track and what follows it in play order; clicking a queued track jumps to it.

import { HiXMark } from "react-icons/hi2";
import type { MusicTrack } from "@/lib/tauri";
import { PlayingBars } from "@/plugins/music/components/PlayingBars";
import { formatDuration } from "@/plugins/music/lib/format";
import { useMusicStore } from "@/plugins/music/stores/musicStore";

export function QueuePanel() {
	const open = useMusicStore((s) => s.queueOpen);
	const toggle = useMusicStore((s) => s.toggleQueue);
	const queue = useMusicStore((s) => s.queue);
	const order = useMusicStore((s) => s.order);
	const orderPos = useMusicStore((s) => s.orderPos);
	const playbackStatus = useMusicStore((s) => s.playbackStatus);
	const jumpTo = useMusicStore((s) => s.jumpTo);

	if (!open) return null;

	const current = orderPos >= 0 ? queue[order[orderPos]] : null;
	const upcoming = order
		.slice(orderPos + 1)
		.map((qi, i) => ({ track: queue[qi], pos: orderPos + 1 + i }));

	return (
		<div className="absolute bottom-full right-3 z-30 mb-2 flex max-h-[55vh] w-80 flex-col rounded-xl border border-base-300 bg-base-100 shadow-2xl">
			<div className="flex items-center justify-between border-b border-base-300 px-3 py-2">
				<span className="text-xs font-semibold uppercase tracking-wider text-base-content/60">
					Queue
				</span>
				<button
					type="button"
					className="btn btn-ghost btn-xs btn-circle"
					onClick={toggle}
				>
					<HiXMark className="size-4" />
				</button>
			</div>
			<div className="overflow-y-auto p-1.5">
				{current && (
					<>
						<SectionLabel>Now playing</SectionLabel>
						<QueueRow track={current} playing={playbackStatus === "playing"} />
					</>
				)}
				{upcoming.length > 0 ? (
					<>
						<SectionLabel>Up next</SectionLabel>
						{upcoming.map(({ track, pos }) => (
							<QueueRow
								key={`${track.asset_id}-${pos}`}
								track={track}
								onClick={() => jumpTo(pos)}
							/>
						))}
					</>
				) : (
					<div className="px-2 py-4 text-center text-xs text-base-content/40">
						Nothing up next
					</div>
				)}
			</div>
		</div>
	);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-base-content/40">
			{children}
		</div>
	);
}

function QueueRow({
	track,
	playing = false,
	onClick,
}: {
	track: MusicTrack;
	playing?: boolean;
	onClick?: () => void;
}) {
	const isCurrent = onClick === undefined;
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={isCurrent}
			className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
				isCurrent ? "text-primary" : "hover:bg-base-content/5"
			}`}
		>
			<span className="flex w-4 shrink-0 justify-center">
				{isCurrent && playing && <PlayingBars className="text-primary" />}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm leading-tight">
					{track.title}
				</span>
				<span className="block truncate text-xs text-base-content/55">
					{track.artist}
				</span>
			</span>
			<span className="shrink-0 text-[11px] tabular-nums text-base-content/45">
				{formatDuration(track.duration_secs)}
			</span>
		</button>
	);
}
