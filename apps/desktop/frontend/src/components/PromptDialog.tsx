// SPDX-License-Identifier: AGPL-3.0-or-later
//! Promise-returning text-input dialog. `prompt({...})` returns a
//! `Promise<string | null>` that resolves to the trimmed input on confirm
//! (or null on cancel / Escape / backdrop click). One `<PromptDialogRoot />`
//! mounted at the top of the app handles all prompts — sibling primitive to
//! `ConfirmDialog`.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

export type PromptOptions = {
	title: string;
	message?: string;
	initialValue?: string;
	placeholder?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** If provided, the confirm button is disabled while this returns a non-
	 *  empty string. Otherwise empty / unchanged input is allowed. */
	validate?: (value: string) => string | null;
	/** Inclusive range of characters to pre-select in the input on open.
	 *  Defaults to the full string — handy for rename (whole filename
	 *  selected, ready to overtype). */
	selection?: { start: number; end: number };
};

type DialogState = {
	open: boolean;
	options: PromptOptions | null;
	resolve: ((value: string | null) => void) | null;
};

const useDialogStore = create<DialogState>(() => ({
	open: false,
	options: null,
	resolve: null,
}));

export function prompt(options: PromptOptions): Promise<string | null> {
	return new Promise((resolve) => {
		const prev = useDialogStore.getState().resolve;
		if (prev) prev(null);
		useDialogStore.setState({ open: true, options, resolve });
	});
}

function close(answer: string | null) {
	const { resolve } = useDialogStore.getState();
	useDialogStore.setState({ open: false, options: null, resolve: null });
	resolve?.(answer);
}

export function PromptDialogRoot() {
	const { open, options } = useDialogStore();
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [value, setValue] = useState("");

	useEffect(() => {
		if (!open || !options) return;
		setValue(options.initialValue ?? "");
	}, [open, options]);

	useEffect(() => {
		if (!open) return;
		// Defer focus + selection to after the input is rendered with its
		// initial value, otherwise the selection lands on an empty input.
		const t = setTimeout(() => {
			const input = inputRef.current;
			if (!input) return;
			input.focus();
			const sel = options?.selection;
			if (sel) {
				input.setSelectionRange(sel.start, sel.end);
			} else {
				input.select();
			}
		}, 0);
		return () => clearTimeout(t);
	}, [open, options]);

	useEffect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				close(null);
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	if (!open || !options) return null;
	const {
		title,
		message,
		placeholder,
		confirmLabel = "Confirm",
		cancelLabel = "Cancel",
		validate,
	} = options;

	const error = validate?.(value) ?? null;
	const confirmDisabled = error !== null;

	function submit() {
		if (confirmDisabled) return;
		close(value.trim());
	}

	return createPortal(
		<div
			className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-6"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) close(null);
			}}
		>
			<form
				role="dialog"
				aria-modal="true"
				className="bg-base-100 border border-base-300 rounded-lg shadow-xl max-w-md w-full"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div className="p-5 space-y-3">
					<h2 className="text-base font-semibold">{title}</h2>
					{message && (
						<p className="text-sm text-base-content/70 whitespace-pre-wrap">
							{message}
						</p>
					)}
					<input
						ref={inputRef}
						type="text"
						value={value}
						placeholder={placeholder}
						onChange={(e) => setValue(e.target.value)}
						className="input input-sm input-bordered w-full"
					/>
					{error && (
						<p className="text-xs text-error">{error}</p>
					)}
				</div>
				<div className="flex justify-end gap-2 px-4 py-3 border-t border-base-300 bg-base-200/50 rounded-b-lg">
					<button
						type="button"
						className="btn btn-sm btn-ghost"
						onClick={() => close(null)}
					>
						{cancelLabel}
					</button>
					<button
						type="submit"
						className="btn btn-sm btn-primary"
						disabled={confirmDisabled}
					>
						{confirmLabel}
					</button>
				</div>
			</form>
		</div>,
		document.body,
	);
}
