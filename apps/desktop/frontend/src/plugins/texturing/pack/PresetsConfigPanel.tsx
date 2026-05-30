// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePackStore } from "@/plugins/texturing/stores/packStore";
import { LuPlus, LuTrash2 } from "react-icons/lu";

interface PresetLabels {
	r: string;
	g: string;
	b: string;
	a: string;
	r_invert: boolean;
	g_invert: boolean;
	b_invert: boolean;
	a_invert: boolean;
}

interface PackingPreset {
	name: string;
	description: string;
	builtin: boolean;
	labels: PresetLabels;
}

const emptyForm = {
	name: "",
	description: "",
	r: "",
	g: "",
	b: "",
	a: "",
	r_invert: false,
	g_invert: false,
	b_invert: false,
	a_invert: false,
};

const channelSlots = [
	{ key: "r" as const, label: "R", invertKey: "r_invert" as const },
	{ key: "g" as const, label: "G", invertKey: "g_invert" as const },
	{ key: "b" as const, label: "B", invertKey: "b_invert" as const },
	{ key: "a" as const, label: "A", invertKey: "a_invert" as const },
];

export default function PresetsConfigPanel() {
	const refreshPackerPresets = usePackStore((s) => s.loadPresets);

	const [builtinPresets, setBuiltinPresets] = useState<PackingPreset[]>([]);
	const [userPresets, setUserPresets] = useState<PackingPreset[]>([]);
	const [showForm, setShowForm] = useState(false);
	const [form, setForm] = useState(emptyForm);

	const loadAllPresets = useCallback(async () => {
		try {
			const builtin = await invoke<PackingPreset[]>("get_builtin_presets");
			const user = await invoke<PackingPreset[]>("load_user_presets");
			setBuiltinPresets(builtin);
			setUserPresets(user);
		} catch (err) {
			console.error("Failed to load presets:", err);
		}
	}, []);

	useEffect(() => {
		loadAllPresets();
	}, [loadAllPresets]);

	const handleSavePreset = useCallback(async () => {
		if (!form.name.trim()) return;
		const preset: PackingPreset = {
			name: form.name.trim(),
			description: form.description.trim(),
			builtin: false,
			labels: {
				r: form.r.trim(),
				g: form.g.trim(),
				b: form.b.trim(),
				a: form.a.trim(),
				r_invert: form.r_invert,
				g_invert: form.g_invert,
				b_invert: form.b_invert,
				a_invert: form.a_invert,
			},
		};
		try {
			await invoke("save_user_preset", { preset });
			setForm(emptyForm);
			setShowForm(false);
			await loadAllPresets();
			await refreshPackerPresets();
		} catch (err) {
			console.error("Failed to save preset:", err);
		}
	}, [form, loadAllPresets, refreshPackerPresets]);

	const handleDeletePreset = useCallback(async (name: string) => {
		try {
			await invoke("delete_user_preset", { name });
			await loadAllPresets();
			await refreshPackerPresets();
		} catch (err) {
			console.error("Failed to delete preset:", err);
		}
	}, [loadAllPresets, refreshPackerPresets]);

	return (
		<div className="p-6 max-w-lg space-y-8">
			{/* Channel Packing Presets */}
			<section>
				<h2 className="text-sm font-semibold mb-3">Channel Packing Presets</h2>

				{/* Built-in presets */}
				<div className="space-y-1.5 mb-4">
					<p className="text-xs text-base-content/50 font-medium uppercase tracking-wider">Built-in</p>
					{builtinPresets.map((p) => (
						<div key={p.name} className="flex items-baseline gap-2 text-sm">
							<span className="font-medium text-base-content/80">{p.name}</span>
							<span className="text-xs text-base-content/40">{p.description}</span>
						</div>
					))}
				</div>

				{/* User presets */}
				<div className="space-y-1.5 mb-3">
					<p className="text-xs text-base-content/50 font-medium uppercase tracking-wider">Custom</p>
					{userPresets.length === 0 && (
						<p className="text-xs text-base-content/30">No custom presets yet.</p>
					)}
					{userPresets.map((p) => (
						<div key={p.name} className="flex items-center gap-2 text-sm">
							<span className="font-medium text-base-content/80 flex-1">{p.name}</span>
							<span className="text-xs text-base-content/40 flex-1">{p.description}</span>
							<button
								type="button"
								onClick={() => handleDeletePreset(p.name)}
								className="btn btn-ghost btn-xs h-6 min-h-0 px-1 text-error/60 hover:text-error"
								title="Delete preset"
							>
								<LuTrash2 size={12} />
							</button>
						</div>
					))}
				</div>

				{/* Add preset form */}
				{showForm ? (
					<div className="rounded-lg border border-base-300 bg-base-200/50 p-3 space-y-2">
						<input
							type="text"
							value={form.name}
							onChange={(e) => setForm({ ...form, name: e.target.value })}
							placeholder="Preset name"
							className="input input-xs input-bordered w-full"
						/>
						<input
							type="text"
							value={form.description}
							onChange={(e) => setForm({ ...form, description: e.target.value })}
							placeholder="Brief description"
							className="input input-xs input-bordered w-full"
						/>
						<div className="grid grid-cols-4 gap-1.5">
							{channelSlots.map((ch) => (
								<div key={ch.key} className="flex flex-col gap-1">
									<label className="text-xs font-bold text-base-content/50">{ch.label}</label>
									<input
										type="text"
										value={form[ch.key]}
										onChange={(e) => setForm({ ...form, [ch.key]: e.target.value })}
										placeholder="Label"
										className="input input-xs input-bordered w-full"
									/>
									<label className="flex items-center gap-1 cursor-pointer">
										<input
											type="checkbox"
											checked={form[ch.invertKey]}
											onChange={(e) => setForm({ ...form, [ch.invertKey]: e.target.checked })}
											className="checkbox checkbox-xs checkbox-primary"
										/>
										<span className="text-xs text-base-content/40">Invert</span>
									</label>
								</div>
							))}
						</div>
						<div className="flex gap-2 pt-1">
							<button
								type="button"
								onClick={handleSavePreset}
								disabled={!form.name.trim()}
								className="btn btn-primary btn-xs"
							>
								Save
							</button>
							<button
								type="button"
								onClick={() => { setShowForm(false); setForm(emptyForm); }}
								className="btn btn-ghost btn-xs"
							>
								Cancel
							</button>
						</div>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setShowForm(true)}
						className="btn btn-ghost btn-xs gap-1"
					>
						<LuPlus size={12} />
						Add Custom Preset
					</button>
				)}
			</section>
		</div>
	);
}
