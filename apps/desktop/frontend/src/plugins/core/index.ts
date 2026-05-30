// SPDX-License-Identifier: AGPL-3.0-or-later
//! The built-in `core` pseudo-plugin. It's always enabled and carries the base
//! Automations steps (Convert / Resize / Rename) so they travel through the
//! exact same contribution mechanism as plugin steps.

import { registerPlugin } from "@/plugins/registry";
import { coreAutomationSteps } from "@/plugins/core/steps";

registerPlugin({
	id: "core",
	name: "Core",
	description: "Built-in base operations.",
	automationSteps: coreAutomationSteps,
});
