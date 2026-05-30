// SPDX-License-Identifier: AGPL-3.0-or-later
//! Automation steps contributed by the 3D Texturing plugin. Both are
//! param-less normal-map ops; their executors live in the Rust `automations`
//! module (delegating to `texturing::normal_map`). They appear in the
//! Automations palette only while the plugin is enabled.

import { HiArrowsUpDown, HiArrowPathRoundedSquare } from "react-icons/hi2";
import type { AutomationStepContribution } from "@/plugins/types";

const flipGreenStep: AutomationStepContribution = {
	type: "flip-green",
	label: "Flip Green (DX↔GL)",
	description: "Invert the green channel to swap normal-map conventions.",
	icon: HiArrowsUpDown,
	group: "texturing",
	defaultParams: () => ({}),
};

const normalizeStep: AutomationStepContribution = {
	type: "normalize",
	label: "Normalize",
	description: "Re-normalize normal-map vectors to unit length.",
	icon: HiArrowPathRoundedSquare,
	group: "texturing",
	defaultParams: () => ({}),
};

export const texturingAutomationSteps: AutomationStepContribution[] = [
	flipGreenStep,
	normalizeStep,
];
