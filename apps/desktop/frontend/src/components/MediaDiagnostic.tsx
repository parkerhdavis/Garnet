// SPDX-License-Identifier: AGPL-3.0-or-later
//! Asset-detail-page diagnostic panel. Runs a battery of checks against the
//! asset URL and the OS-level "open externally" plugin so we can tell apart:
//!
//!   1. Asset protocol not serving anything (URL → 404, network error)
//!   2. Asset protocol serving but `<video>` rejects (URL → 200 with bytes, no
//!      Accept-Ranges or wrong MIME)
//!   3. Codec rejected (URL serves correctly but webkit's media element can't
//!      decode)
//!   4. Open-externally plugin failing silently
//!
//! Auto-runs on mount + when invoked manually via the Run button.

import { useEffect, useState } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

type FetchProbe = {
	method: string;
	rangeHeader: string | null;
	ok: boolean | null;
	status: number | null;
	statusText: string;
	headers: Record<string, string>;
	bodyPreview: string;
	error: string | null;
	durationMs: number;
};

type OpenerProbe = {
	op: "openPath" | "revealItemInDir";
	ok: boolean | null;
	error: string | null;
	durationMs: number;
};

async function probeFetch(
	url: string,
	method: "HEAD" | "GET",
	range: string | null,
): Promise<FetchProbe> {
	const t0 = performance.now();
	const headers: Record<string, string> = {};
	if (range) headers.Range = range;
	try {
		const res = await fetch(url, { method, headers });
		const resHeaders: Record<string, string> = {};
		res.headers.forEach((v, k) => {
			resHeaders[k] = v;
		});
		let bodyPreview = "";
		if (method === "GET") {
			const buf = await res.arrayBuffer();
			const bytes = new Uint8Array(buf);
			const first = bytes.slice(0, 24);
			bodyPreview = `${bytes.length} bytes; first 24: ${Array.from(first)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join(" ")}`;
		}
		return {
			method,
			rangeHeader: range,
			ok: res.ok,
			status: res.status,
			statusText: res.statusText,
			headers: resHeaders,
			bodyPreview,
			error: null,
			durationMs: performance.now() - t0,
		};
	} catch (e) {
		return {
			method,
			rangeHeader: range,
			ok: false,
			status: null,
			statusText: "",
			headers: {},
			bodyPreview: "",
			error: String(e),
			durationMs: performance.now() - t0,
		};
	}
}

async function probeOpener(absPath: string): Promise<OpenerProbe[]> {
	const results: OpenerProbe[] = [];
	for (const [op, fn] of [
		["openPath", () => openPath(absPath)],
		["revealItemInDir", () => revealItemInDir(absPath)],
	] as const) {
		const t0 = performance.now();
		try {
			await fn();
			results.push({ op, ok: true, error: null, durationMs: performance.now() - t0 });
		} catch (e) {
			results.push({
				op,
				ok: false,
				error: String(e),
				durationMs: performance.now() - t0,
			});
		}
	}
	return results;
}

type Props = {
	url: string;
	absPath: string;
	autoRun?: boolean;
};

export function MediaDiagnostic({ url, absPath, autoRun = false }: Props) {
	const [head, setHead] = useState<FetchProbe | null>(null);
	const [getFull, setGetFull] = useState<FetchProbe | null>(null);
	const [getRange, setGetRange] = useState<FetchProbe | null>(null);
	const [opener, setOpener] = useState<OpenerProbe[]>([]);
	const [running, setRunning] = useState(false);
	const [hasRun, setHasRun] = useState(false);

	async function run() {
		setRunning(true);
		setHead(null);
		setGetFull(null);
		setGetRange(null);
		setOpener([]);
		const h = await probeFetch(url, "HEAD", null);
		setHead(h);
		const g = await probeFetch(url, "GET", null);
		setGetFull(g);
		const r = await probeFetch(url, "GET", "bytes=0-1023");
		setGetRange(r);
		setRunning(false);
		setHasRun(true);
	}

	async function runOpener() {
		setOpener([]);
		const r = await probeOpener(absPath);
		setOpener(r);
	}

	useEffect(() => {
		if (autoRun && !hasRun) void run();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [autoRun, url]);

	return (
		<div className="card bg-base-100 border border-warning/40">
			<div className="card-body p-4 text-xs">
				<div className="flex items-center justify-between">
					<h2 className="card-title text-sm">Media diagnostic</h2>
					<div className="flex gap-2">
						<button
							type="button"
							className="btn btn-xs"
							onClick={() => void run()}
							disabled={running}
						>
							{running ? "Running…" : hasRun ? "Re-run fetches" : "Run fetches"}
						</button>
						<button
							type="button"
							className="btn btn-xs"
							onClick={() => void runOpener()}
						>
							Run open-externally
						</button>
					</div>
				</div>

				<ProbeRow label="HEAD asset url" probe={head} />
				<ProbeRow label="GET full" probe={getFull} />
				<ProbeRow label="GET bytes=0-1023" probe={getRange} />

				{opener.length > 0 && (
					<div className="mt-2 space-y-1">
						<div className="text-base-content/60">opener plugin</div>
						{opener.map((o) => (
							<div key={o.op} className="font-mono">
								<span
									className={
										o.ok ? "text-success" : o.ok === false ? "text-error" : "opacity-60"
									}
								>
									{o.ok ? "✓" : "✗"}
								</span>{" "}
								<span>{o.op}</span>{" "}
								<span className="opacity-60">({o.durationMs.toFixed(0)}ms)</span>
								{o.error && (
									<div className="ml-4 text-error break-all">{o.error}</div>
								)}
							</div>
						))}
					</div>
				)}

				<details className="mt-3 opacity-70">
					<summary className="cursor-pointer">URL / path</summary>
					<div className="font-mono break-all mt-1">
						<div>
							<span className="text-base-content/50">asset url:</span> {url}
						</div>
						<div>
							<span className="text-base-content/50">abs path:</span> {absPath}
						</div>
					</div>
				</details>
			</div>
		</div>
	);
}

function ProbeRow({ label, probe }: { label: string; probe: FetchProbe | null }) {
	if (!probe) {
		return (
			<div className="mt-2 font-mono opacity-50">
				<span>{label}:</span> <span>—</span>
			</div>
		);
	}
	const ok = probe.ok && probe.error === null;
	return (
		<div className="mt-2 font-mono">
			<div>
				<span className={ok ? "text-success" : "text-error"}>
					{ok ? "✓" : "✗"}
				</span>{" "}
				<span>{label}</span>{" "}
				<span className="opacity-60">({probe.durationMs.toFixed(0)}ms)</span>{" "}
				<span>
					{probe.status === null
						? "no response"
						: `${probe.status} ${probe.statusText}`}
				</span>
			</div>
			{probe.error && (
				<div className="ml-4 text-error break-all">error: {probe.error}</div>
			)}
			{probe.bodyPreview && <div className="ml-4 opacity-70">{probe.bodyPreview}</div>}
			{Object.keys(probe.headers).length > 0 && (
				<details className="ml-4 opacity-70">
					<summary className="cursor-pointer">headers</summary>
					<div className="ml-2">
						{Object.entries(probe.headers)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([k, v]) => (
								<div key={k} className="break-all">
									<span className="text-base-content/50">{k}:</span> {v}
								</div>
							))}
					</div>
				</details>
			)}
		</div>
	);
}
