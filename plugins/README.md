This directory holds the manifest mirrors for Garnet's first-party plugins. The plugin-loading model is **compiled-in + registry**: a plugin's Rust commands and React UI live in the Garnet repo and compile into the single binary, behind a real plugin boundary (a manifest, a frontend contribution registry, and per-plugin enable/disable state). True dynamic loading (cdylib / sidecar) is deferred — it only matters for out-of-scope third-party plugins. See the Plugin System design doc in the project wiki for the design space.

# What's here today

- `texturing/manifest.json` — descriptive manifest for the **3D Texturing** plugin (Garnet's first plugin: channel packing, normal-map ops, texture-size analysis, material preview). It mirrors the behavioral source of truth, which is the frontend registration under `apps/desktop/frontend/src/plugins/texturing/`.
- `example-plugin/manifest.json` — the original placeholder showing the proposed manifest fields. Kept as a shape reference.

# Where a compiled-in plugin actually lives

- **Frontend** (`apps/desktop/frontend/src/plugins/`):
  - `registry.ts` + `types.ts` — the contribution registry. A plugin self-registers at startup via a static-import side effect (`plugins/index.ts` imports each plugin's `index.ts`).
  - `<id>/index.ts` — a plugin registers a `GarnetPlugin` describing its **workflows** (specialized workspace-interior UIs bound to a workspace type) and **automation steps** (pipeline steps for the Automations module). The built-in `core` pseudo-plugin registers the base automation steps the same way.
  - The 3D Texturing plugin's UI lives under `plugins/texturing/` (its `TexturingWorkflow`, the Pack/Adjust/Size/Preview tools, stores, and the PBR scene).
- **Backend** (`apps/desktop/backend/src/`):
  - `texturing/` — the native commands (channel pack, normal map, presets), registered in `main.rs`'s `invoke_handler`.
  - `image_io.rs` — base image I/O (EXR/TGA-capable) reusable by any plugin.
- **Enable/disable** state is persisted in `AppSettings.enabled_plugins` (settings.json); the in-app Plugins manager (`pages/PluginsPage.tsx`) toggles it.

# What's still not here

- A runtime loader for **disk** manifests beyond the `list_plugins` enumeration stub (`apps/desktop/backend/src/plugins.rs`) — that path is reserved for any future third-party plugins.
- A `manifest.json` schema enforced by the host, sandboxing, or signing.
