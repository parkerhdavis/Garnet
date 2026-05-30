// SPDX-License-Identifier: AGPL-3.0-or-later
//! The 3D Texturing workflow — the interior rendered for a "texturing"-type
//! workspace. Packi-style layout: a single left sidebar holds the module list
//! (top) plus the INPUT/OUTPUT working-directory panels (below); the active
//! module's tool fills the rest. The workspace context provides the working
//! dirs to the shared DropZone/ExportPanel.

import { useState } from "react";
import type { Workspace } from "@/lib/tauri";
import { TexturingWorkspaceProvider } from "@/plugins/texturing/workspaceContext";
import {
	TexturingSidebar,
	type TexturingModuleId,
} from "@/plugins/texturing/TexturingSidebar";
import PackTools from "@/plugins/texturing/tools/PackTools";
import SizeTools from "@/plugins/texturing/tools/SizeTools";
import NormalMapTools from "@/plugins/texturing/tools/NormalMapTools";
import PreviewTools from "@/plugins/texturing/tools/PreviewTools";

export function TexturingWorkflow({ workspace }: { workspace: Workspace }) {
	const [module, setModule] = useState<TexturingModuleId>("pack");

	return (
		<TexturingWorkspaceProvider workspace={workspace}>
			<div className="flex-1 min-h-0 flex">
				<TexturingSidebar
					module={module}
					onModule={setModule}
					workspaceName={workspace.name}
				/>
				<div className="flex-1 min-h-0">
					{module === "pack" && <PackTools />}
					{module === "adjust" && <NormalMapTools />}
					{module === "size" && <SizeTools />}
					{module === "preview" && <PreviewTools />}
				</div>
			</div>
		</TexturingWorkspaceProvider>
	);
}
