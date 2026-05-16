// SPDX-License-Identifier: AGPL-3.0-or-later
//! App → Stats. Currently surfaces the latest startup-time breakdown emitted
//! by `startup_timing::StartupTimings::finalize_and_save` on the backend.
//! Other stats sections (cache sizes, indexer throughput, etc.) can stack on
//! top of this without restructuring — the page is intentionally a list of
//! independent cards rather than a single fixed-shape report.

import { useEffect, useState } from "react";
import { HiArrowPath, HiChartBar } from "react-icons/hi2";
import { api, type StartupReport } from "@/lib/tauri";

export function AppStatsPage() {
	const [report, setReport] = useState<StartupReport | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = () => {
		setLoading(true);
		setError(null);
		api.getStartupTimings()
			.then((r) => setReport(r))
			.catch((e) => setError(String(e)))
			.finally(() => setLoading(false));
	};

	useEffect(load, []);

	return (
		<div className="flex-1 min-h-0 overflow-auto p-6">
			<div className="max-w-3xl mx-auto">
				<header className="flex items-center gap-3 mb-6">
					<div className="size-10 rounded-lg bg-base-200 flex items-center justify-center">
						<HiChartBar className="size-5 text-base-content/70" />
					</div>
					<div className="flex-1 min-w-0">
						<h1 className="text-xl font-semibold tracking-tight">Stats</h1>
						<p className="text-sm text-base-content/60">
							Diagnostics about how Garnet is running on your machine.
						</p>
					</div>
					<button type="button" className="btn btn-sm btn-ghost" onClick={load} title="Reload">
						<HiArrowPath className="size-4" />
					</button>
				</header>

				<StartupBreakdownCard report={report} loading={loading} error={error} />
			</div>
		</div>
	);
}

function StartupBreakdownCard({
	report,
	loading,
	error,
}: {
	report: StartupReport | null;
	loading: boolean;
	error: string | null;
}) {
	return (
		<section className="card bg-base-100 border border-base-300">
			<div className="card-body gap-3">
				<div className="flex items-center justify-between gap-4">
					<h2 className="card-title text-base">Startup breakdown</h2>
					{report && (
						<div className="text-xs text-base-content/60 tabular-nums">
							captured {formatRecordedAt(report.recorded_at_unix_ms)}
						</div>
					)}
				</div>
				<p className="text-sm text-base-content/70">
					The splash is the budget. Everything should finish before it fades; if
					total startup exceeds the splash's intentional dwell, that's a real
					delay the user perceives. Pre-splash time is implicit overhead the
					user sees as a blank/missing window.
				</p>
				{loading ? (
					<div className="py-6 flex justify-center">
						<span className="loading loading-spinner loading-sm opacity-50" />
					</div>
				) : error ? (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				) : !report ? (
					<div className="py-6 text-center text-sm text-base-content/60">
						No startup report saved yet. Restart the app to capture one.
					</div>
				) : (
					<>
						<BudgetSummary report={report} />
						<PhaseTable report={report} />
					</>
				)}
			</div>
		</section>
	);
}

/// React-mount and splash-dismissed events anchor the budget comparison.
/// We look them up by name; if either is missing (older builds, partial
/// finalize), we degrade gracefully and show what we can.
function findPhaseEnd(report: StartupReport, name: string): number | null {
	const p = report.phases.find((p) => p.name === name);
	if (!p) return null;
	return p.start_offset_ms + p.duration_ms;
}
function findPhaseStart(report: StartupReport, name: string): number | null {
	const p = report.phases.find((p) => p.name === name);
	return p ? p.start_offset_ms : null;
}

function BudgetSummary({ report }: { report: StartupReport }) {
	const budget = report.splash_budget_ms;
	const reactMountedAt = findPhaseEnd(report, "frontend: React mounted");
	const splashDismissedAt =
		findPhaseEnd(report, "frontend: splash fade complete") ??
		findPhaseEnd(report, "frontend: splash dismissed");
	const dataLoadedAt = findPhaseEnd(report, "frontend: initial data loaded");

	// Pre-splash overhead: time from launch until the splash could appear
	// (i.e., React mount, which is when the splash JSX first paints). This is
	// "blank window" time from the user's perspective.
	const preSplashMs = reactMountedAt ?? null;
	// Splash dwell: time from React mount to splash gone. In the happy case
	// this exactly equals the splash budget. If it's longer, slow data load
	// pushed past SPLASH_MIN_MS and extended the dwell.
	const dwellMs = reactMountedAt !== null && splashDismissedAt !== null
		? splashDismissedAt - reactMountedAt
		: null;
	const dwellExtension = budget !== null && dwellMs !== null
		? Math.max(0, dwellMs - budget)
		: null;
	// Data load relative to splash min: did the initial fetches finish before
	// the splash would've faded anyway?
	const dataLoadIntoSplashMs = reactMountedAt !== null && dataLoadedAt !== null
		? dataLoadedAt - reactMountedAt
		: null;

	const overshootPreSplash = preSplashMs !== null && preSplashMs > 300;
	const overshootDwell = (dwellExtension ?? 0) > 50;
	const onTime = !overshootPreSplash && !overshootDwell;

	return (
		<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
			<div className={`rounded-lg border p-3 ${onTime ? "border-success/40 bg-success/5" : "border-warning/50 bg-warning/5"}`}>
				<div className="text-[10px] uppercase tracking-wider opacity-60 mb-1">Verdict</div>
				<div className="text-base font-semibold">
					{onTime ? "On time" : "Overran the splash"}
				</div>
				<div className="text-xs opacity-70 mt-1">
					Total {formatMs(report.total_ms)}
					{budget !== null && ` · budget ${formatMs(budget)}`}
				</div>
			</div>
			<div className="rounded-lg border border-base-300 p-3 grid grid-cols-2 gap-2 text-xs">
				<Metric
					label="Pre-splash"
					value={preSplashMs}
					highlight={overshootPreSplash}
					hint="Time before the splash can paint"
				/>
				<Metric
					label="Splash dwell"
					value={dwellMs}
					hint="React mount → splash gone"
				/>
				<Metric
					label="Splash extension"
					value={dwellExtension}
					highlight={overshootDwell}
					hint="Dwell beyond the budget"
				/>
				<Metric
					label="Data into splash"
					value={dataLoadIntoSplashMs}
					hint={budget !== null ? `Min visible ${budget - 500}ms` : undefined}
				/>
			</div>
		</div>
	);
}

function Metric({
	label,
	value,
	hint,
	highlight,
}: {
	label: string;
	value: number | null;
	hint?: string;
	highlight?: boolean;
}) {
	return (
		<div>
			<div className="text-[10px] uppercase tracking-wider opacity-60">{label}</div>
			<div className={`font-semibold tabular-nums ${highlight ? "text-warning" : ""}`}>
				{value === null ? "—" : formatMs(value)}
			</div>
			{hint && <div className="text-[10px] opacity-50">{hint}</div>}
		</div>
	);
}

function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}

/// Phases whose "duration" is intentional waiting, not real work. These get
/// muted styling and are excluded from the heat-map scale so a 2-second
/// dwell doesn't make actual 100ms phases look insignificant.
const DWELL_PHASES = new Set([
	"frontend: splash min elapsed (fade starts)",
	"frontend: splash fade complete",
	"frontend: splash dismissed", // legacy name from earlier reports
]);

function PhaseTable({ report }: { report: StartupReport }) {
	const reactMountedAt = findPhaseStart(report, "frontend: React mounted") ?? 0;
	const slowest = report.phases
		.filter((p) => !DWELL_PHASES.has(p.name))
		.reduce((m, p) => Math.max(m, p.duration_ms), 0);
	return (
		<div className="overflow-x-auto -mx-2">
			<table className="table table-zebra table-sm">
				<thead>
					<tr>
						<th className="w-12 text-center" title="Pre-splash vs splash-window">Where</th>
						<th className="text-right w-20">Started</th>
						<th className="text-right w-20">Duration</th>
						<th>Phase</th>
						<th>Note</th>
					</tr>
				</thead>
				<tbody>
					{report.phases.map((p, i) => {
						const isPreSplash = p.start_offset_ms < reactMountedAt;
						const isDwell = DWELL_PHASES.has(p.name);
						return (
							<tr key={`${p.name}-${i}`}>
								<td className="text-center text-[10px] opacity-60" title={isPreSplash ? "Before splash painted" : isDwell ? "Splash dwell (intentional)" : "Splash window"}>
									{isPreSplash ? "pre" : isDwell ? "fade" : "splash"}
								</td>
								<td className="text-right tabular-nums text-base-content/60">
									+{p.start_offset_ms}&nbsp;ms
								</td>
								<td className="text-right tabular-nums">
									{isDwell ? (
										<span className="opacity-50">{p.duration_ms}&nbsp;ms</span>
									) : (
										<DurationCell ms={p.duration_ms} max={slowest} />
									)}
								</td>
								<td className="font-medium">{p.name}</td>
								<td className="text-base-content/70 text-xs">{p.note ?? ""}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function DurationCell({ ms, max }: { ms: number; max: number }) {
	// Mild heat-map: anything that took >25% of the worst non-dwell phase is
	// highlighted. Gives a quick visual scan for the actual bottleneck.
	const fraction = max === 0 ? 0 : ms / max;
	const cls =
		fraction > 0.75
			? "text-error font-semibold"
			: fraction > 0.25
			? "text-warning font-medium"
			: "";
	return <span className={cls}>{ms}&nbsp;ms</span>;
}

function formatRecordedAt(unixMs: number): string {
	if (!unixMs) return "—";
	const d = new Date(unixMs);
	return d.toLocaleString();
}
