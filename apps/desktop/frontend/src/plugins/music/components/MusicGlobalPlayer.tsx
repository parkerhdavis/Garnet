// SPDX-License-Identifier: AGPL-3.0-or-later
//! The Music Library's app-global UI, mounted by the Layout via the plugin
//! `global` slot so it stays alive across navigation — playback continues after
//! you leave the music workspace. Renders nothing when nothing is playing (the
//! queue panel anchors directly above the player bar via the relative wrapper).

import { useEffect } from "react";
import { PlayerBar } from "@/plugins/music/components/PlayerBar";
import { QueuePanel } from "@/plugins/music/components/QueuePanel";
import { useMusicStore } from "@/plugins/music/stores/musicStore";

function isEditable(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el) return false;
	const tag = el.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	return el.isContentEditable;
}

/// Ctrl/Cmd + ←/→ steps the playing queue (prev/next), app-wide while
/// something is playing. Lives in the music plugin (not the core App hotkeys)
/// to keep the plugin boundary clean; this component is globally mounted so the
/// shortcut works from any view. (On macOS, Ctrl+←/→ is a system Spaces
/// shortcut — Cmd+←/→ is the reliable chord there.)
function useTrackNavHotkeys() {
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
			if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
			if (isEditable(e.target)) return;
			const s = useMusicStore.getState();
			if (!s.nowPlaying) return;
			e.preventDefault();
			if (e.key === "ArrowLeft") s.prev();
			else s.next();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}

export function MusicGlobalPlayer() {
	useTrackNavHotkeys();
	return (
		<div className="relative">
			<QueuePanel />
			<PlayerBar />
		</div>
	);
}
