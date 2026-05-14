// SPDX-License-Identifier: AGPL-3.0-or-later
//! Reusable placeholder for routes scaffolded in this style pass that don't
//! have functionality yet. Each new section in the sidebar mounts one of
//! these so the navigation feels real; behavior lands in a later phase.

import type { IconType } from "react-icons";

type Props = {
	title: string;
	icon: IconType;
	description?: string;
};

export function StubPage({ title, icon: Icon, description }: Props) {
	return (
		<div className="flex-1 min-h-0 flex flex-col items-center justify-center p-12 text-center">
			<div className="size-16 rounded-full bg-base-100 border border-base-300 flex items-center justify-center text-base-content/40 mb-5">
				<Icon className="size-7" />
			</div>
			<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
			{description && (
				<p className="text-sm text-base-content/60 mt-2 max-w-md">
					{description}
				</p>
			)}
			<div className="mt-6 text-[11px] uppercase tracking-wider text-base-content/35">
				Coming in a future phase
			</div>
		</div>
	);
}
