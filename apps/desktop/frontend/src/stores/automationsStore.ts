// SPDX-License-Identifier: AGPL-3.0-or-later
//! State for the Automations module: the input file list, the ordered step
//! pipeline, output dir, live preview, and run progress. Ported from Packi's
//! batchStore. A pipeline step keeps `type` and `params` separate so a step's
//! ParamsEditor edits just the params; the two are flattened into the backend
//! `{ type, ...params }` shape when invoking.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useBgTasksStore } from "@/stores/bgTasksStore";

export type AutomationStepInstance = {
	type: string;
	params: Record<string, unknown>;
};

export type AutomationPreviewItem = {
	input_path: string;
	output_filename: string;
	output_format: string;
};

export type AutomationResult = {
	processed: number;
	failed: Array<{ path: string; error: string }>;
};

export type AutomationProgress = {
	current: number;
	total: number;
	current_file: string;
};

export type NamedPipeline = {
	name: string;
	steps: Array<{ type: string } & Record<string, unknown>>;
};

const BG_TASK_ID = "automation:run";

/// Flatten a step instance into the backend `{ type, ...params }` payload.
function toBackendStep(step: AutomationStepInstance) {
	return { type: step.type, ...step.params };
}

/// Split a backend `{ type, ...params }` step into `{ type, params }`.
function fromBackendStep(
	step: { type: string } & Record<string, unknown>,
): AutomationStepInstance {
	const { type, ...params } = step;
	return { type, params };
}

type AutomationsState = {
	inputFiles: string[];
	pipeline: AutomationStepInstance[];
	outputDir: string | null;
	previewItems: AutomationPreviewItem[];
	running: boolean;
	progress: AutomationProgress | null;
	result: AutomationResult | null;
	presets: NamedPipeline[];
	recursive: boolean;
	continueOnError: boolean;

	addFiles: (paths: string[]) => void;
	addFolder: (dir: string) => Promise<void>;
	removeFile: (index: number) => void;
	clearFiles: () => void;
	addStep: (step: AutomationStepInstance) => void;
	removeStep: (index: number) => void;
	updateStepParams: (index: number, params: Record<string, unknown>) => void;
	moveStep: (from: number, to: number) => void;
	setOutputDir: (dir: string) => void;
	setRecursive: (recursive: boolean) => void;
	setContinueOnError: (v: boolean) => void;
	previewPipeline: () => Promise<void>;
	runPipeline: () => Promise<void>;
	loadPresets: () => Promise<void>;
	savePreset: (name: string) => Promise<void>;
	deletePreset: (name: string) => Promise<void>;
	applyPreset: (preset: NamedPipeline) => void;
};

export const useAutomationsStore = create<AutomationsState>((set, get) => ({
	inputFiles: [],
	pipeline: [],
	outputDir: null,
	previewItems: [],
	running: false,
	progress: null,
	result: null,
	presets: [],
	recursive: false,
	continueOnError: true,

	addFiles: (paths) =>
		set((s) => ({
			inputFiles: [
				...s.inputFiles,
				...paths.filter((p) => !s.inputFiles.includes(p)),
			],
			result: null,
		})),

	addFolder: async (dir) => {
		try {
			const files = await invoke<string[]>("list_image_files", {
				dir,
				recursive: get().recursive,
			});
			get().addFiles(files);
		} catch (err) {
			console.error("Failed to list image files:", err);
		}
	},

	removeFile: (index) =>
		set((s) => ({ inputFiles: s.inputFiles.filter((_, i) => i !== index) })),

	clearFiles: () => set({ inputFiles: [], previewItems: [], result: null }),

	addStep: (step) => set((s) => ({ pipeline: [...s.pipeline, step] })),

	removeStep: (index) =>
		set((s) => ({ pipeline: s.pipeline.filter((_, i) => i !== index) })),

	updateStepParams: (index, params) =>
		set((s) => ({
			pipeline: s.pipeline.map((step, i) =>
				i === index ? { ...step, params } : step,
			),
		})),

	moveStep: (from, to) =>
		set((s) => {
			const steps = [...s.pipeline];
			const [moved] = steps.splice(from, 1);
			steps.splice(to, 0, moved);
			return { pipeline: steps };
		}),

	setOutputDir: (dir) => set({ outputDir: dir }),
	setRecursive: (recursive) => set({ recursive }),
	setContinueOnError: (continueOnError) => set({ continueOnError }),

	previewPipeline: async () => {
		const { inputFiles, pipeline } = get();
		if (inputFiles.length === 0) return;
		try {
			const items = await invoke<AutomationPreviewItem[]>(
				"preview_automation",
				{
					files: inputFiles,
					pipeline: { steps: pipeline.map(toBackendStep) },
				},
			);
			set({ previewItems: items });
		} catch (err) {
			console.error("Automation preview failed:", err);
		}
	},

	runPipeline: async () => {
		const { inputFiles, pipeline, outputDir, continueOnError } = get();
		if (inputFiles.length === 0 || !outputDir) return;

		set({ running: true, progress: null, result: null });
		useBgTasksStore
			.getState()
			.add({ id: BG_TASK_ID, kind: "other", label: "Running automation" });

		const unlisten = await listen<AutomationProgress>(
			"automation:progress",
			(event) => {
				set({ progress: event.payload });
			},
		);

		try {
			const result = await invoke<AutomationResult>("run_automation", {
				files: inputFiles,
				pipeline: { steps: pipeline.map(toBackendStep) },
				outputDir,
				continueOnError,
			});
			set({ result, running: false });
		} catch (err) {
			console.error("Automation run failed:", err);
			set({ running: false });
		} finally {
			unlisten();
			useBgTasksStore.getState().remove(BG_TASK_ID);
		}
	},

	loadPresets: async () => {
		try {
			const presets = await invoke<NamedPipeline[]>("load_automation_presets");
			set({ presets });
		} catch (err) {
			console.error("Failed to load automation presets:", err);
		}
	},

	savePreset: async (name) => {
		const steps = get().pipeline.map(toBackendStep);
		await invoke("save_automation_preset", { name, steps });
		await get().loadPresets();
	},

	deletePreset: async (name) => {
		await invoke("delete_automation_preset", { name });
		await get().loadPresets();
	},

	applyPreset: (preset) =>
		set({ pipeline: preset.steps.map(fromBackendStep), result: null }),
}));
