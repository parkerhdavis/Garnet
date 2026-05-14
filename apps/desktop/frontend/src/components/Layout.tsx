// SPDX-License-Identifier: AGPL-3.0-or-later
import { Outlet } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";

export function Layout() {
	// `h-screen` (exactly viewport-tall, not min-h-screen) anchors the
	// whole frame so the sidebar / filter bar / pagination stay put and
	// only the inner overflow-auto pane scrolls. `overflow-hidden` on the
	// main pane prevents content from growing past the viewport and lets
	// its child overflow-auto take over the scroll.
	return (
		<div className="h-screen flex overflow-hidden">
			<Sidebar />
			<div className="flex-1 min-w-0 flex flex-col bg-base-200 overflow-hidden">
				<Outlet />
			</div>
		</div>
	);
}
