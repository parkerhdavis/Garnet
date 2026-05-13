This directory sketches Garnet's module manifest shape. **No loader exists yet** — the module-loading model (dynamic Rust plugin / sidecar process / JS-only with native primitives in base) is a deliberate open question. See the Module System design doc in the project wiki for the design space and the staged plan that defers this decision until there's a real prototype to test against.

# What's here today

- `example-module/manifest.json` — a placeholder showing the proposed manifest fields (`identity`, `version`, `name`, `description`, `contributions`). All contribution arrays are empty. This file is not loaded or executed; it exists so the shape is real and reviewable before any Phase 2 work begins.

# What's not

- Any actual module loader, runtime, or sandbox.
- A `manifest.json` schema enforced by the host.
- An in-app module manager UI.
- Anything to do with the "3D Texturing" module (eventual Packi port) — that's Phase 3.

# What `list_modules` does on the Rust side

`apps/desktop/backend/src/modules.rs` exposes a `list_modules` Tauri command that enumerates `<config_dir>/garnet/modules/<id>/manifest.json` from disk and deserializes whatever it finds. It never actually invokes module code. The repo's `example-module/` is a documentation artifact and is not copied to that runtime path by anything in the scaffold.

When the loader lands, this directory's role will be revisited — it might become the source-of-truth for first-party modules' manifest schemas, or it might disappear entirely in favor of per-module repos.
