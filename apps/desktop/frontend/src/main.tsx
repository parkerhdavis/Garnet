// SPDX-License-Identifier: AGPL-3.0-or-later
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./lib/tauri";
import App from "./App";

// First thing the webview's JS does after the bundle loads. Records a
// checkpoint so the startup breakdown shows the gap between Tauri's
// .setup() return and the script actually being able to talk back.
void api.markStartupPhase("webview: bundle script ran").catch(() => {});

const root = document.getElementById("root")!;
root.className = "bg-base-200 min-h-screen";

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
