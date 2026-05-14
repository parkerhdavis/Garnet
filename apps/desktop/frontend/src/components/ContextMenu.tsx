// SPDX-License-Identifier: AGPL-3.0-or-later
//! Global right-click context menu. One `<ContextMenuRoot />` is mounted at
//! the top of the app; any component can imperatively open the menu via
//! `openContextMenu(event, items)`. The menu renders into a portal at the
//! cursor coordinates and closes on outside click, Escape, or item activation.
//!
//! Why a single global root instead of a hook-returned element per consumer:
//! the right-click target and the menu have no parent/child relationship in
//! the React tree (the menu is positioned at the viewport), so funneling
//! every consumer through their own portal would duplicate state and risk
//! multiple menus open at once. Singleton state guarantees exactly one menu.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IconType } from "react-icons";
import { create } from "zustand";

export type ContextMenuItem =
	| {
			kind?: "item";
			label: string;
			icon?: IconType;
			onClick: () => void | Promise<void>;
			disabled?: boolean;
			/** Renders the item in error tone. Use for destructive actions. */
			danger?: boolean;
	  }
	| { kind: "separator" };

type MenuState = {
	open: boolean;
	x: number;
	y: number;
	items: ContextMenuItem[];
};

const useMenuStore = create<MenuState>(() => ({
	open: false,
	x: 0,
	y: 0,
	items: [],
}));

export function openContextMenu(
	event: { preventDefault: () => void; clientX: number; clientY: number },
	items: ContextMenuItem[],
) {
	event.preventDefault();
	useMenuStore.setState({
		open: true,
		x: event.clientX,
		y: event.clientY,
		items,
	});
}

export function closeContextMenu() {
	useMenuStore.setState({ open: false });
}

export function ContextMenuRoot() {
	const { open, x, y, items } = useMenuStore();
	const ref = useRef<HTMLDivElement | null>(null);
	// Final on-screen position, adjusted to keep the menu inside the viewport.
	// Defaults to the click coords; the layout effect below shifts it if the
	// menu would overflow the right/bottom edge.
	const [pos, setPos] = useState({ x, y });

	useLayoutEffect(() => {
		if (!open) return;
		setPos({ x, y });
	}, [open, x, y]);

	useLayoutEffect(() => {
		if (!open || !ref.current) return;
		const rect = ref.current.getBoundingClientRect();
		const pad = 4;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		let nx = x;
		let ny = y;
		if (nx + rect.width + pad > vw) nx = Math.max(pad, vw - rect.width - pad);
		if (ny + rect.height + pad > vh) ny = Math.max(pad, vh - rect.height - pad);
		if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny });
		// We intentionally only recompute when `open` flips or coords change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, x, y]);

	useEffect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") closeContextMenu();
		}
		function onScroll() {
			closeContextMenu();
		}
		window.addEventListener("keydown", onKey);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onScroll);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onScroll);
		};
	}, [open]);

	if (!open) return null;

	return createPortal(
		<>
			{/* Outside-click catcher. Pointer events stop here so the click
			    doesn't fall through to whatever is underneath the menu. */}
			<div
				className="fixed inset-0 z-[60]"
				onMouseDown={(e) => {
					e.preventDefault();
					e.stopPropagation();
					closeContextMenu();
				}}
				onContextMenu={(e) => {
					// Right-clicking the backdrop closes the menu instead of
					// opening the browser's native context menu.
					e.preventDefault();
					closeContextMenu();
				}}
			/>
			<div
				ref={ref}
				role="menu"
				className="fixed z-[61] min-w-[180px] bg-base-100 border border-base-300 rounded-md shadow-lg py-1 text-sm select-none"
				style={{ left: pos.x, top: pos.y }}
				onMouseDown={(e) => e.stopPropagation()}
				onContextMenu={(e) => e.preventDefault()}
			>
				{items.map((item, i) => {
					if (item.kind === "separator") {
						return (
							<div
								key={i}
								className="my-1 h-px bg-base-300"
								role="separator"
							/>
						);
					}
					const { label, icon: Icon, onClick, disabled, danger } = item;
					return (
						<button
							key={i}
							type="button"
							role="menuitem"
							disabled={disabled}
							onClick={() => {
								closeContextMenu();
								void onClick();
							}}
							className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
								disabled
									? "opacity-40 cursor-not-allowed"
									: danger
										? "text-error hover:bg-error/15"
										: "hover:bg-base-200"
							}`}
						>
							{Icon && <Icon className="size-4 shrink-0" />}
							<span className="truncate">{label}</span>
						</button>
					);
				})}
			</div>
		</>,
		document.body,
	);
}
