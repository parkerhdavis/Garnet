// SPDX-License-Identifier: AGPL-3.0-or-later
//! Registration for the 3D Texturing plugin (Garnet's first plugin). It
//! contributes one workflow type ("texturing") whose interior is the
//! TexturingWorkflow, and two Automations steps (Flip Green / Normalize). The
//! native commands these tools call are compiled into the binary
//! (`backend/src/texturing/`).

import { HiCube } from "react-icons/hi2";
import { registerPlugin } from "@/plugins/registry";
import { TexturingWorkflow } from "@/plugins/texturing/TexturingWorkflow";
import { texturingAutomationSteps } from "@/plugins/texturing/steps";

registerPlugin({
	id: "texturing",
	manifestIdentity: "com.parkerhdavis.garnet.texturing",
	name: "3D Texturing",
	version: "0.1.0",
	description:
		"Channel packing, normal-map operations, texture-size analysis, and material preview for game-art texture workflows.",
	workflows: [
		{
			workspaceType: "texturing",
			label: "3D Texturing",
			icon: HiCube,
			description:
				"A texture workspace with channel packing, normal-map tools, size analysis, and preview.",
			Component: TexturingWorkflow,
		},
	],
	automationSteps: texturingAutomationSteps,
});
