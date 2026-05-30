// SPDX-License-Identifier: AGPL-3.0-or-later
//! The built-in `core` pseudo-plugin. It's always enabled and carries the base
//! Automations steps (Rename / Resize / Convert) so they travel through the
//! exact same contribution mechanism as plugin steps. The step definitions
//! land in commit 7 (alongside the Automations frontend); for now this just
//! establishes the always-on registration.

import { registerPlugin } from "@/plugins/registry";

registerPlugin({
	id: "core",
	name: "Core",
	description: "Built-in base operations.",
	automationSteps: [],
});
