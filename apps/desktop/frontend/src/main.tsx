// SPDX-License-Identifier: AGPL-3.0-or-later
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const root = document.getElementById("root")!;
// h-screen + overflow-hidden anchors the app to the viewport so the
// LibraryPage's `overflow-auto` pane scrolls independently instead of
// pushing the whole page (including the sidebar) past the viewport edge.
root.className = "bg-base-200 h-screen overflow-hidden";

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
