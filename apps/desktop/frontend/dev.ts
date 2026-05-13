// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Development Server
 *
 * Serves built output on port 5173 (where Tauri expects it) and triggers
 * full-page reloads via WebSocket on source changes. HMR is intentionally not
 * implemented — state lives in Zustand stores and survives page reloads.
 */

import { watch } from "fs";
import { cp, mkdir } from "fs/promises";
import { existsSync } from "fs";
import type { ServerWebSocket } from "bun";

const DEV_PORT = 5173;
const DIST = "dist";

const reloadClients = new Set<ServerWebSocket<unknown>>();

async function buildCSS() {
	const proc = Bun.spawn(
		["bunx", "@tailwindcss/cli", "-i", "src/styles/index.css", "-o", `${DIST}/styles.css`],
		{ stdout: "inherit", stderr: "inherit" },
	);
	await proc.exited;
}

async function buildMain() {
	const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
	await Bun.build({
		entrypoints: ["src/main.tsx"],
		outdir: DIST,
		target: "browser",
		naming: "[name].js",
		define: {
			"process.env.NODE_ENV": '"development"',
			"__APP_VERSION__": JSON.stringify(pkg.version),
		},
	});
}

async function copyAssets() {
	if (existsSync("public")) {
		await cp("public", DIST, { recursive: true });
	}
	let html = await Bun.file("index.html").text();
	const reloadScript = `<script>new WebSocket("ws://localhost:${DEV_PORT}/__reload").onmessage=()=>location.reload()</script>`;
	html = html.replace("</body>", `${reloadScript}\n</body>`);
	await Bun.write(`${DIST}/index.html`, html);
}

async function buildAll() {
	await mkdir(DIST, { recursive: true });
	await Promise.all([buildCSS(), buildMain(), copyAssets()]);
}

console.log("Building...");
await buildAll();

Bun.serve({
	port: DEV_PORT,
	async fetch(req, server) {
		const url = new URL(req.url);
		if (url.pathname === "/__reload") {
			if (server.upgrade(req)) return undefined;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}
		const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
		const file = Bun.file(`${DIST}${filePath}`);
		if (!(await file.exists())) return new Response("Not found", { status: 404 });
		return new Response(file);
	},
	websocket: {
		open(ws) { reloadClients.add(ws); },
		close(ws) { reloadClients.delete(ws); },
		message() {},
	},
});

console.log(`Dev server running at http://localhost:${DEV_PORT}`);

let rebuildTimer: Timer | null = null;

function scheduleRebuild() {
	if (rebuildTimer) clearTimeout(rebuildTimer);
	rebuildTimer = setTimeout(async () => {
		const start = performance.now();
		try {
			await buildAll();
			const ms = (performance.now() - start).toFixed(0);
			console.log(`Rebuilt in ${ms}ms — reloading`);
			for (const client of reloadClients) {
				client.send("reload");
			}
		} catch (e) {
			console.error("Rebuild failed:", e);
		}
	}, 100);
}

watch("src", { recursive: true }, scheduleRebuild);
watch("index.html", scheduleRebuild);
