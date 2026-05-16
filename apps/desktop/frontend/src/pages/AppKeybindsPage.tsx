// SPDX-License-Identifier: AGPL-3.0-or-later
//! App → Keybinds. Reference page listing every keyboard shortcut Garnet
//! responds to, grouped by category. Data comes from `lib/keybinds.ts`
//! (single source so handlers and this page can't drift).
import { HiCommandLine } from "react-icons/hi2";
import { KEYBIND_CATEGORIES, type Keybind } from "@/lib/keybinds";

export function AppKeybindsPage() {
	return (
		<div className="flex-1 min-h-0 overflow-auto p-6">
			<div className="max-w-3xl mx-auto">
				<header className="flex items-center gap-3 mb-6">
					<div className="size-10 rounded-lg bg-base-200 flex items-center justify-center">
						<HiCommandLine className="size-5 text-base-content/70" />
					</div>
					<div>
						<h1 className="text-xl font-semibold tracking-tight">Keybinds</h1>
						<p className="text-sm text-base-content/60">
							Keyboard shortcuts for navigation, selection, animation playback,
							and editing.
						</p>
					</div>
				</header>

				<div className="space-y-4">
					{KEYBIND_CATEGORIES.map((cat) => (
						<section
							key={cat.title}
							className="card bg-base-100 border border-base-300"
						>
							<div className="card-body gap-3 p-5">
								<h2 className="card-title text-base">{cat.title}</h2>
								<ul className="divide-y divide-base-300">
									{cat.items.map((item) => (
										<KeybindRow key={item.description} item={item} />
									))}
								</ul>
								{cat.hint && (
									<p className="text-xs text-base-content/55 mt-1">{cat.hint}</p>
								)}
							</div>
						</section>
					))}
				</div>
			</div>
		</div>
	);
}

function KeybindRow({ item }: { item: Keybind }) {
	return (
		<li className="flex items-center justify-between gap-4 py-2 text-sm">
			<span className="text-base-content/80">{item.description}</span>
			<span className="flex items-center gap-1 shrink-0">
				{item.keys.map((k, i) => (
					<span key={`${k}-${i}`} className="flex items-center gap-1">
						{i > 0 && <span className="text-[10px] text-base-content/40">+</span>}
						<kbd className="kbd kbd-sm">{k}</kbd>
					</span>
				))}
			</span>
		</li>
	);
}
