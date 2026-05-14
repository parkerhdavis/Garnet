This directory sketches Garnet's plugin manifest shape. **No loader exists yet** — the plugin-loading model (dynamic Rust plugin / sidecar process / JS-only with native primitives in base) is a deliberate open question. See the Plugin System design doc in the project wiki for the design space and the staged plan that defers this decision until there's a real prototype to test against.

# What's here today

- `example-plugin/manifest.json` — a placeholder showing the proposed manifest fields (`identity`, `version`, `name`, `description`, `contributions`). All contribution arrays are empty. This file is not loaded or executed; it exists so the shape is real and reviewable before any Phase 2 work begins.

# What's not

- Any actual plugin loader, runtime, or sandbox.
- A `manifest.json` schema enforced by the host.
- An in-app plugin manager UI.
- Anything to do with the "3D Texturing" plugin (eventual Packi port) — that's Phase 3.

# What `list_plugins` does on the Rust side

`apps/desktop/backend/src/plugins.rs` exposes a `list_plugins` Tauri command that enumerates `<config_dir>/garnet/plugins/<id>/manifest.json` from disk and deserializes whatever it finds. It never actually invokes plugin code. The repo's `example-plugin/` is a documentation artifact and is not copied to that runtime path by anything in the scaffold.

When the loader lands, this directory's role will be revisited — it might become the source-of-truth for first-party plugins' manifest schemas, or it might disappear entirely in favor of per-plugin repos.
