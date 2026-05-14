// SPDX-License-Identifier: AGPL-3.0-or-later
import { NavLink, Outlet } from "react-router-dom";
import { HiPhoto, HiCog6Tooth } from "react-icons/hi2";

const NAV_ITEMS = [
	{ to: "/", label: "Library", icon: HiPhoto },
	{ to: "/settings", label: "Settings", icon: HiCog6Tooth },
] as const;

export function Layout() {
	return (
		// `fixed inset-0` anchors the whole layout to the viewport regardless
		// of what wraps the routes (SplashGate, ErrorBoundary, etc.) — every
		// time I've tried to rely on a percent-height chain through those
		// wrappers, something further down stops being able to compute a
		// definite height and the inner overflow-auto pane breaks.
		<div className="fixed inset-0 flex">
			<aside className="w-56 shrink-0 bg-base-100 border-r border-base-300 flex flex-col">
				<div className="px-4 py-4 border-b border-base-300">
					<div className="text-lg font-semibold tracking-tight">Garnet</div>
					<div className="text-xs text-base-content/60">v{__APP_VERSION__}</div>
				</div>
				<nav className="flex-1 p-2">
					<ul className="menu menu-sm w-full">
						{NAV_ITEMS.map(({ to, label, icon: Icon }) => (
							<li key={to}>
								<NavLink
									to={to}
									end={to === "/"}
									className={({ isActive }) => (isActive ? "menu-active" : "")}
								>
									<Icon className="size-4" />
									{label}
								</NavLink>
							</li>
						))}
					</ul>
				</nav>
				<div className="p-3 text-[10px] text-base-content/40 border-t border-base-300">
					Phase 1 — base toolkit
				</div>
			</aside>
			<div className="flex-1 min-w-0 flex flex-col bg-base-200">
				<Outlet />
			</div>
		</div>
	);
}
