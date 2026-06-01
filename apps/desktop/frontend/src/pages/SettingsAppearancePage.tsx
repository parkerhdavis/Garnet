// SPDX-License-Identifier: AGPL-3.0-or-later
//! Appearance settings. Currently the accent-color picker; theme/density/font
//! controls will join here later.

import { HiSwatch } from "react-icons/hi2";
import { ACCENT_PRESETS, accentPrimaryCss } from "@/lib/accent";
import { usePrefsStore } from "@/stores/prefsStore";

export function SettingsAppearancePage() {
	const accentId = usePrefsStore((s) => s.accentId);
	const setAccentId = usePrefsStore((s) => s.setAccentId);

	return (
		<div className="flex-1 min-h-0 overflow-auto p-6">
			<div className="max-w-2xl mx-auto">
				<header className="flex items-center gap-3 mb-6">
					<div className="size-10 rounded-lg bg-base-200 flex items-center justify-center">
						<HiSwatch className="size-5 text-base-content/70" />
					</div>
					<div>
						<h1 className="text-xl font-semibold tracking-tight">Appearance</h1>
						<p className="text-sm text-base-content/60">
							Accent color now; theme, density, and font size later.
						</p>
					</div>
				</header>

				<section className="card bg-base-100 border border-base-300">
					<div className="card-body gap-3">
						<h2 className="card-title text-base">Accent color</h2>
						<p className="text-sm text-base-content/70">
							Recolors highlights, buttons, and the logo. Backgrounds keep their
							warm-neutral tone.
						</p>
						<div className="flex flex-wrap gap-2 mt-2">
							{ACCENT_PRESETS.map((preset) => {
								const active = preset.id === accentId;
								return (
									<button
										key={preset.id}
										type="button"
										onClick={() => setAccentId(preset.id)}
										aria-pressed={active}
										title={preset.name}
										className={`flex flex-col items-center gap-1.5 rounded-lg p-2 transition-colors ${
											active ? "bg-base-200" : "hover:bg-base-200/60"
										}`}
									>
										<span
											className={`size-10 rounded-full ring-2 ring-offset-2 ring-offset-base-100 ${
												active ? "ring-base-content/70" : "ring-transparent"
											}`}
											style={{ backgroundColor: accentPrimaryCss(preset.hue) }}
										/>
										<span
											className={`text-xs ${
												active ? "font-semibold" : "text-base-content/70"
											}`}
										>
											{preset.name}
										</span>
									</button>
								);
							})}
						</div>
					</div>
				</section>
			</div>
		</div>
	);
}
