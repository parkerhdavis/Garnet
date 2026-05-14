// SPDX-License-Identifier: AGPL-3.0-or-later
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const root = document.getElementById("root")!;
root.className = "bg-base-200 min-h-screen";

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
