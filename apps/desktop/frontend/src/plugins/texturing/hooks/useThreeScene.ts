// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, useCallback } from "react";
import type {
	PBRSceneConfig,
	PBRSceneStatus,
} from "@/plugins/texturing/types/pbr";
import { PBRSceneManager } from "@/plugins/texturing/preview/pbr/PBRSceneManager";

export function useThreeScene(
	containerRef: React.RefObject<HTMLDivElement | null>,
	config: PBRSceneConfig,
): PBRSceneStatus {
	const [ready, setReady] = useState(false);
	const managerRef = useRef<PBRSceneManager | null>(null);

	// Mount / unmount the scene manager
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const manager = new PBRSceneManager(el, () => setReady(true));
		managerRef.current = manager;

		// ResizeObserver for container-based sizing
		const ro = new ResizeObserver(() => manager.resize());
		ro.observe(el);

		return () => {
			ro.disconnect();
			manager.dispose();
			managerRef.current = null;
			setReady(false);
		};
	}, [containerRef]);

	// Push config updates to the manager
	useEffect(() => {
		managerRef.current?.updateConfig(config);
	}, [config]);

	const captureViewport = useCallback((): string | null => {
		return managerRef.current?.captureViewport() ?? null;
	}, []);

	return { ready, captureViewport };
}
