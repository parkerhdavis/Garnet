// SPDX-License-Identifier: AGPL-3.0-or-later
//! The Automations module UI: build an ordered pipeline of steps and run it
//! over a set of image files (non-destructive, writes to a separate output
//! dir). The step palette is sourced from the plugin registry — base steps
//! (Convert/Resize/Rename) plus any enabled plugin's steps (the 3D Texturing
//! plugin contributes Flip Green / Normalize). Ported from Packi's batch
//! processor, adapted to Garnet's registry, stores, and dialogs.

import { useEffect, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
	HiBolt,
	HiChevronDown,
	HiChevronUp,
	HiFolderOpen,
	HiPlay,
	HiPlus,
	HiTrash,
	HiCheck,
	HiXMark,
} from "react-icons/hi2";
import { confirm } from "@/components/ConfirmDialog";
import { prompt } from "@/components/PromptDialog";
import { allAutomationSteps, getPlugin } from "@/plugins/registry";
import type { AutomationStepContribution } from "@/plugins/types";
import { enabledAutomationSteps } from "@/stores/pluginsStore";
import { usePluginsStore } from "@/stores/pluginsStore";
import {
	type NamedPipeline,
	useAutomationsStore,
} from "@/stores/automationsStore";

const IMAGE_EXTS = ["png", "tga", "jpg", "jpeg", "tif", "tiff", "bmp", "exr"];

export function AutomationsPage() {
	// Re-derive the palette when plugin enable-state changes.
	const enabledIds = usePluginsStore((s) => s.enabledIds);
	const {
		inputFiles,
		pipeline,
		outputDir,
		previewItems,
		running,
		progress,
		result,
		presets,
		recursive,
		continueOnError,
		addFiles,
		addFolder,
		removeFile,
		clearFiles,
		addStep,
		removeStep,
		updateStepParams,
		moveStep,
		setOutputDir,
		setRecursive,
		setContinueOnError,
		previewPipeline,
		runPipeline,
		loadPresets,
		savePreset,
		deletePreset,
		applyPreset,
	} = useAutomationsStore();

	// Look up a contribution by step type — uses the full registry (not just
	// enabled) so a step from a since-disabled plugin still renders.
	const contributionByType = useMemo(() => {
		const map = new Map<string, AutomationStepContribution>();
		for (const { contribution } of allAutomationSteps())
			map.set(contribution.type, contribution);
		return map;
	}, []);

	// Palette grouped by contributing source ("Base" + each enabled plugin).
	const paletteGroups = useMemo(() => {
		const groups = new Map<string, AutomationStepContribution[]>();
		for (const c of enabledAutomationSteps()) {
			const key =
				c.group === "base" ? "Base" : (getPlugin(c.group)?.name ?? c.group);
			const arr = groups.get(key) ?? [];
			arr.push(c);
			groups.set(key, arr);
		}
		return [...groups.entries()];
	}, [enabledIds]);

	useEffect(() => {
		void loadPresets();
	}, [loadPresets]);

	// Auto-refresh the preview when inputs or pipeline change (debounced).
	useEffect(() => {
		if (inputFiles.length === 0 || pipeline.length === 0) {
			useAutomationsStore.setState({ previewItems: [] });
			return;
		}
		const t = setTimeout(() => void previewPipeline(), 300);
		return () => clearTimeout(t);
	}, [inputFiles, pipeline, previewPipeline]);

	async function handleAddFiles() {
		const picked = await open({
			multiple: true,
			filters: [{ name: "Images", extensions: IMAGE_EXTS }],
		});
		if (Array.isArray(picked)) addFiles(picked);
	}

	async function handleAddFolder() {
		const picked = await open({ directory: true });
		if (typeof picked === "string") await addFolder(picked);
	}

	async function handlePickOutputDir() {
		const picked = await open({ directory: true });
		if (typeof picked === "string") setOutputDir(picked);
	}

	async function handleSavePreset() {
		const name = await prompt({
			title: "Save pipeline preset",
			confirmLabel: "Save",
			validate: (v) => (v.trim() ? null : "Name cannot be empty"),
		});
		if (name) await savePreset(name.trim());
	}

	async function handleDeletePreset(name: string) {
		const ok = await confirm({
			title: "Delete preset?",
			message: `"${name}" will be removed.`,
			confirmLabel: "Delete",
			danger: true,
		});
		if (ok) await deletePreset(name);
	}

	const canRun =
		inputFiles.length > 0 && pipeline.length > 0 && !!outputDir && !running;

	return (
		<div className="flex-1 min-h-0 flex flex-col">
			<header className="px-4 py-3 border-b border-base-300 bg-base-100 flex items-center gap-3 shrink-0">
				<div className="size-9 rounded-lg bg-base-200 flex items-center justify-center">
					<HiBolt className="size-5 text-base-content/70" />
				</div>
				<div className="flex-1 min-w-0">
					<h1 className="text-lg font-semibold tracking-tight leading-tight">
						Automations
					</h1>
					<p className="text-xs text-base-content/55">
						Bulk-process image files through a reusable pipeline.
						Non-destructive — always writes to a separate output folder.
					</p>
				</div>
				<PresetMenu
					presets={presets}
					onApply={applyPreset}
					onSave={handleSavePreset}
					onDelete={handleDeletePreset}
					canSave={pipeline.length > 0}
				/>
			</header>

			<div className="flex flex-1 min-h-0">
				{/* Input files */}
				<div className="w-60 shrink-0 flex flex-col border-r border-base-300">
					<div className="p-2 border-b border-base-300 flex items-center gap-1">
						<span className="text-xs font-semibold text-base-content/50 flex-1">
							Input ({inputFiles.length})
						</span>
						<button
							type="button"
							onClick={handleAddFiles}
							className="btn btn-ghost btn-xs"
							title="Add files"
						>
							<HiPlus className="size-4" />
						</button>
						<button
							type="button"
							onClick={handleAddFolder}
							className="btn btn-ghost btn-xs"
							title="Add folder"
						>
							<HiFolderOpen className="size-4" />
						</button>
						{inputFiles.length > 0 && (
							<button
								type="button"
								onClick={clearFiles}
								className="btn btn-ghost btn-xs text-error"
								title="Clear all"
							>
								<HiTrash className="size-4" />
							</button>
						)}
					</div>
					<label className="px-2 py-1 border-b border-base-300 flex items-center gap-2 cursor-pointer">
						<input
							type="checkbox"
							className="checkbox checkbox-xs checkbox-primary"
							checked={recursive}
							onChange={(e) => setRecursive(e.target.checked)}
						/>
						<span className="text-xs text-base-content/50">
							Include subfolders
						</span>
					</label>
					<div className="flex-1 overflow-y-auto">
						{inputFiles.length === 0 ? (
							<button
								type="button"
								onClick={handleAddFiles}
								className="flex flex-col items-center justify-center h-full gap-2 text-base-content/30 hover:text-base-content/50 w-full text-xs"
							>
								<HiPlus className="size-6" />
								Add files or a folder
							</button>
						) : (
							inputFiles.map((f, i) => (
								<div
									key={f}
									className="flex items-center gap-1 px-2 py-1 hover:bg-base-200 group"
								>
									<span className="text-xs truncate flex-1" title={f}>
										{f.split(/[\\/]/).pop()}
									</span>
									<button
										type="button"
										onClick={() => removeFile(i)}
										className="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100"
									>
										<HiTrash className="size-3" />
									</button>
								</div>
							))
						)}
					</div>
				</div>

				{/* Pipeline */}
				<div className="w-72 shrink-0 flex flex-col border-r border-base-300">
					<div className="p-2 border-b border-base-300 flex items-center gap-1">
						<span className="text-xs font-semibold text-base-content/50 flex-1">
							Pipeline
						</span>
						<div className="dropdown dropdown-end">
							<button
								type="button"
								tabIndex={0}
								className="btn btn-ghost btn-xs"
								title="Add step"
							>
								<HiPlus className="size-4" />
							</button>
							<ul
								tabIndex={0}
								className="dropdown-content menu p-1 shadow bg-base-200 rounded-box w-48 z-20"
							>
								{paletteGroups.map(([groupLabel, steps]) => (
									<li key={groupLabel}>
										<h2 className="menu-title text-[10px] uppercase py-1">
											{groupLabel}
										</h2>
										<ul>
											{steps.map((st) => {
												const Icon = st.icon;
												return (
													<li key={st.type}>
														<button
															type="button"
															className="text-xs"
															onClick={() =>
																addStep({
																	type: st.type,
																	params: st.defaultParams(),
																})
															}
														>
															<Icon className="size-3.5" />
															{st.label}
														</button>
													</li>
												);
											})}
										</ul>
									</li>
								))}
							</ul>
						</div>
					</div>
					<div className="flex-1 overflow-y-auto p-2 space-y-2">
						{pipeline.length === 0 ? (
							<div className="flex items-center justify-center h-full text-base-content/30 text-xs text-center px-4">
								Add processing steps with the + button.
							</div>
						) : (
							pipeline.map((step, i) => {
								const c = contributionByType.get(step.type);
								const Icon = c?.icon;
								const Editor = c?.ParamsEditor;
								return (
									<div
										key={`${step.type}-${i}`}
										className="rounded-lg bg-base-200 border border-base-300 p-2"
									>
										<div className="flex items-center justify-between mb-1">
											<div className="flex items-center gap-1.5 min-w-0">
												{Icon && (
													<Icon className="size-3.5 shrink-0 text-base-content/60" />
												)}
												<span className="text-xs font-semibold truncate">
													{c?.label ?? step.type}
												</span>
											</div>
											<div className="flex items-center gap-0.5">
												<button
													type="button"
													onClick={() => moveStep(i, i - 1)}
													disabled={i === 0}
													className="btn btn-ghost btn-xs px-0.5 disabled:opacity-20"
													title="Move up"
												>
													<HiChevronUp className="size-3" />
												</button>
												<button
													type="button"
													onClick={() => moveStep(i, i + 1)}
													disabled={i === pipeline.length - 1}
													className="btn btn-ghost btn-xs px-0.5 disabled:opacity-20"
													title="Move down"
												>
													<HiChevronDown className="size-3" />
												</button>
												<button
													type="button"
													onClick={() => removeStep(i)}
													className="btn btn-ghost btn-xs px-0.5"
												>
													<HiTrash className="size-3" />
												</button>
											</div>
										</div>
										{Editor && (
											<Editor
												params={step.params}
												onChange={(next) => updateStepParams(i, next)}
											/>
										)}
									</div>
								);
							})
						)}
					</div>
				</div>

				{/* Output + preview */}
				<div className="flex-1 flex flex-col min-w-0">
					<div className="p-3 border-b border-base-300 space-y-2">
						<div className="flex gap-2 items-center">
							<span className="text-xs font-semibold text-base-content/50">
								Output:
							</span>
							<input
								type="text"
								value={outputDir ?? ""}
								readOnly
								placeholder="Select output directory…"
								className="input input-xs input-bordered flex-1 font-mono"
							/>
							<button
								type="button"
								onClick={handlePickOutputDir}
								className="btn btn-ghost btn-xs"
							>
								<HiFolderOpen className="size-4" />
							</button>
						</div>
						<div className="flex gap-2 items-center">
							<button
								type="button"
								onClick={() => void runPipeline()}
								disabled={!canRun}
								className="btn btn-sm btn-primary flex-1"
							>
								{running ? (
									<span className="loading loading-spinner loading-xs" />
								) : (
									<HiPlay className="size-4" />
								)}
								{running ? "Processing…" : "Run"}
							</button>
						</div>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								className="checkbox checkbox-xs checkbox-primary"
								checked={continueOnError}
								onChange={(e) => setContinueOnError(e.target.checked)}
							/>
							<span className="text-xs text-base-content/50">
								Continue on error
							</span>
						</label>
					</div>

					<div className="flex-1 overflow-y-auto">
						{previewItems.length > 0 ? (
							<table className="table table-xs w-full">
								<thead>
									<tr>
										{(running || result) && <th className="w-6" />}
										<th>Input</th>
										<th>Output</th>
										<th>Format</th>
									</tr>
								</thead>
								<tbody>
									{previewItems.map((item, i) => {
										const done = running
											? progress != null && i < progress.current
											: result != null;
										const failure = result?.failed.find(
											(f) => f.path === item.input_path,
										);
										const active =
											running && progress != null && i === progress.current;
										return (
											<tr
												key={item.input_path}
												className={failure ? "bg-error/5" : ""}
											>
												{(running || result) && (
													<td className="w-6 px-1">
														{done && !failure && (
															<HiCheck className="size-3 text-success" />
														)}
														{failure && (
															<HiXMark className="size-3 text-error" />
														)}
														{active && (
															<span className="loading loading-spinner loading-xs" />
														)}
													</td>
												)}
												<td
													className="truncate max-w-32 text-xs"
													title={item.input_path}
												>
													{item.input_path.split(/[\\/]/).pop()}
												</td>
												<td className="text-xs font-mono">
													{failure ? (
														<span className="text-error" title={failure.error}>
															{failure.error}
														</span>
													) : (
														item.output_filename
													)}
												</td>
												<td className="text-xs">{item.output_format}</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						) : (
							<div className="flex items-center justify-center h-full text-base-content/30 text-sm">
								Add files and pipeline steps to preview the output.
							</div>
						)}
					</div>

					{(running || result) && (
						<div className="px-3 py-2 border-t border-base-300 flex items-center gap-3">
							{running && progress && (
								<>
									<span className="text-xs text-base-content/50 shrink-0 tabular-nums">
										{progress.current} / {progress.total}
									</span>
									<progress
										className="progress progress-primary flex-1"
										value={progress.current}
										max={progress.total}
									/>
								</>
							)}
							{result && !running && (
								<p className="text-xs">
									<span className="text-success font-semibold">
										{result.processed}
									</span>{" "}
									processed
									{result.failed.length > 0 && (
										<span>
											,{" "}
											<span className="text-error font-semibold">
												{result.failed.length}
											</span>{" "}
											failed
										</span>
									)}
								</p>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function PresetMenu({
	presets,
	onApply,
	onSave,
	onDelete,
	canSave,
}: {
	presets: NamedPipeline[];
	onApply: (p: NamedPipeline) => void;
	onSave: () => void;
	onDelete: (name: string) => void;
	canSave: boolean;
}) {
	return (
		<div className="dropdown dropdown-end">
			<button type="button" tabIndex={0} className="btn btn-xs">
				Presets
				<HiChevronDown className="size-3" />
			</button>
			<ul
				tabIndex={0}
				className="dropdown-content menu p-1 shadow bg-base-200 rounded-box w-56 z-20"
			>
				<li>
					<button
						type="button"
						className="text-xs"
						onClick={onSave}
						disabled={!canSave}
					>
						<HiPlus className="size-3.5" />
						Save current pipeline…
					</button>
				</li>
				{presets.length > 0 && <div className="divider my-0" />}
				{presets.map((p) => (
					<li key={p.name}>
						<div className="flex items-center gap-1 text-xs">
							<button
								type="button"
								className="flex-1 text-left"
								onClick={() => onApply(p)}
							>
								{p.name}
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-xs px-1"
								onClick={() => onDelete(p.name)}
							>
								<HiTrash className="size-3" />
							</button>
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}
