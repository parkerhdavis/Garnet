// SPDX-License-Identifier: AGPL-3.0-or-later
//! Promise-returning confirmation dialog. `confirm({...})` returns a
//! `Promise<boolean>` that resolves to true on confirm / false on cancel
//! (including Escape and backdrop click). One `<ConfirmDialogRoot />` mounted
//! at the top of the app handles all confirmations.
//!
//! Designed to read like the browser's `window.confirm`: call it from any
//! event handler, await the result, branch on truthy/falsy. Behind the scenes,
//! a zustand store holds the active prompt and resolver.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

export type ConfirmOptions = {
	title: string;
	message?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** Renders the confirm button in error tone. */
	danger?: boolean;
};

type DialogState = {
	open: boolean;
	options: ConfirmOptions | null;
	resolve: ((value: boolean) => void) | null;
};

const useDialogStore = create<DialogState>(() => ({
	open: false,
	options: null,
	resolve: null,
}));

export function confirm(options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		// Resolve any prior unhandled confirm as cancelled so stacked calls
		// can't leak open promises.
		const prev = useDialogStore.getState().resolve;
		if (prev) prev(false);
		useDialogStore.setState({ open: true, options, resolve });
	});
}

function close(answer: boolean) {
	const { resolve } = useDialogStore.getState();
	useDialogStore.setState({ open: false, options: null, resolve: null });
	resolve?.(answer);
}

export function ConfirmDialogRoot() {
	const { open, options } = useDialogStore();
	const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (!open) return;
		// Focus the confirm button so Enter activates it. Cancel-on-Escape
		// is wired by the dialog itself below.
		confirmBtnRef.current?.focus();
	}, [open]);

	useEffect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				close(false);
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	if (!open || !options) return null;
	const {
		title,
		message,
		confirmLabel = "Confirm",
		cancelLabel = "Cancel",
		danger = false,
	} = options;

	return createPortal(
		<div
			className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-6"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) close(false);
			}}
		>
			<div
				role="dialog"
				aria-modal="true"
				className="bg-base-100 border border-base-300 rounded-lg shadow-xl max-w-md w-full"
			>
				<div className="p-5">
					<h2 className="text-base font-semibold mb-2">{title}</h2>
					{message && (
						<p className="text-sm text-base-content/70 whitespace-pre-wrap">
							{message}
						</p>
					)}
				</div>
				<div className="flex justify-end gap-2 px-4 py-3 border-t border-base-300 bg-base-200/50 rounded-b-lg">
					<button
						type="button"
						className="btn btn-sm btn-ghost"
						onClick={() => close(false)}
					>
						{cancelLabel}
					</button>
					<button
						ref={confirmBtnRef}
						type="button"
						className={`btn btn-sm ${danger ? "btn-error" : "btn-primary"}`}
						onClick={() => close(true)}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
