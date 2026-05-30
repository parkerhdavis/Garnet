// SPDX-License-Identifier: AGPL-3.0-or-later
//! The Music Library's app-global UI, mounted by the Layout via the plugin
//! `global` slot so it stays alive across navigation — playback continues after
//! you leave the music workspace. Renders nothing when nothing is playing.

import { PlayerBar } from "@/plugins/music/components/PlayerBar";

export function MusicGlobalPlayer() {
	return <PlayerBar />;
}
