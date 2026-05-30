// SPDX-License-Identifier: AGPL-3.0-or-later
//! Registration for the Music Library plugin (Garnet's second plugin). It
//! contributes one workflow type ("music") whose interior is the MusicWorkflow:
//! a catalog-backed album/artist browser + native-audio player. The workspace's
//! universal working-folder + filters scope which audio the workspace shows; the
//! filters default to the audio extension set. Native commands live in
//! `backend/src/music/`.

import { HiMusicalNote } from "react-icons/hi2";
import { AUDIO_FORMATS } from "@/lib/typeFilters";
import { MusicWorkflow } from "@/plugins/music/MusicWorkflow";
import { registerPlugin } from "@/plugins/registry";

registerPlugin({
	id: "music",
	manifestIdentity: "com.parkerhdavis.garnet.music",
	name: "Music Library",
	version: "0.1.0",
	description:
		"Browse your audio library by album and artist, with a built-in player and waveform.",
	workflows: [
		{
			workspaceType: "music",
			label: "Music Library",
			icon: HiMusicalNote,
			description: "An album/artist music browser with a built-in player and waveform.",
			Component: MusicWorkflow,
			usesWorkingFolder: true,
			defaultFileFilters: AUDIO_FORMATS.join(" "),
		},
	],
});
