// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Production Build Script
 *
 * Replaces Vite's build pipeline with Bun's native bundler + Tailwind CLI.
 * Outputs everything to dist/ for Tauri to bundle into the desktop app.
 *
 * Environment variables (set by Tauri during build):
 *   TAURI_DEBUG  — when truthy, skips minification and enables sourcemaps
 */

import { cp, rm, mkdir } from "fs/promises";
import { existsSync } from "fs";

const DIST = "dist";
const isDebug = !!process.env.TAURI_DEBUG;

// ---------------------------------------------------------------------------
// Clean
// ---------------------------------------------------------------------------
if (existsSync(DIST)) {
	await rm(DIST, { recursive: true });
}
await mkdir(DIST, { recursive: true });

// ---------------------------------------------------------------------------
// CSS — Tailwind CLI (processes @import "tailwindcss" and @plugin "daisyui")
// ---------------------------------------------------------------------------
console.log("  -> Building CSS...");
const cssProc = Bun.spawn(
	[
		"bunx", "@tailwindcss/cli",
		"-i", "src/styles/index.css",
		"-o", `${DIST}/styles.css`,
		...(isDebug ? [] : ["--minify"]),
	],
	{ stdout: "inherit", stderr: "inherit" },
);
await cssProc.exited;
if (cssProc.exitCode !== 0) {
	console.error("CSS build failed");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Main application bundle
// ---------------------------------------------------------------------------
console.log("  -> Building main app...");
const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
const mainResult = await Bun.build({
	entrypoints: ["src/main.tsx"],
	outdir: DIST,
	target: "browser",
	naming: "[name].js",
	minify: !isDebug,
	sourcemap: isDebug ? "linked" : "none",
	define: {
		"process.env.NODE_ENV": isDebug ? '"development"' : '"production"',
		"__APP_VERSION__": JSON.stringify(pkg.version),
	},
});
if (!mainResult.success) {
	console.error("Main build failed:");
	for (const log of mainResult.logs) console.error(log);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Static assets — public/ → dist/, index.html + splash.html → dist/
// ---------------------------------------------------------------------------
console.log("  -> Copying static assets...");
if (existsSync("public")) {
	await cp("public", DIST, { recursive: true });
}
await cp("index.html", `${DIST}/index.html`);
await cp("splash.html", `${DIST}/splash.html`);

console.log("  -> Frontend build complete!");
