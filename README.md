![Garnet Icon](./resources/icons/128x128.png)
# Garnet

A free, open-source desktop application that bundles a general-purpose digital asset manager with a modular system of media-specific operation suites. The base install is a working DAM for any media type you drop into it — cross-format organization, search, preview, and metadata. Optional plugins (3D, 2D, video, audio, fonts, documents, …) add per-format depth on top. Borrowed from Visual Studio's installer model: a small, useful base, with the user assembling exactly the toolset they need.

Garnet is **offline and local** — no proprietary library format, no forced ingestion, no cloud, no accounts. It indexes where files already live.

> [!NOTE]
> Garnet is at the **concept / Phase 1 starter** stage. The base toolkit's scaffolding is in place; real cataloging, tagging, search, and plugin loading are still ahead. The first official plugin will be **3D Texturing**, eventually folding [Packi](https://github.com/parkerhdavis/Packi) in once its plugin API has been prototyped.

## Stack

- **Runtime / Package Manager:** Bun
- **Desktop Framework:** Tauri 2 (Rust backend)
- **Frontend:** React 19 + TypeScript
- **Styling:** Tailwind CSS 4 + daisyUI 5
- **State Management:** Zustand 5
- **Library DB:** SQLite via `rusqlite`

Stack mirrors [Packi](https://github.com/parkerhdavis/Packi) for code reuse and a consistent offline/local ethos.

## Development

```bash
# Install Rust + Bun + system deps, then install JS dependencies
make setup

# Run in development mode (Tauri + frontend hot reload)
make dev

# Build installer for the current platform
make build

# Quality
make lint typecheck test
```

The library SQLite file lands at `$XDG_DATA_HOME/garnet/library.sqlite` (or the OS equivalent); logs go to `$XDG_CONFIG_HOME/garnet/logs/`.

## License

Covered under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE.md](./LICENSE.md).

Beyond that, I only have one rule: **First, do no harm. Then, help where you can.**

## Financial Support

If you have some cash to spare and are inspired to share, that's very kind. Rather than sharing that kindness with me, I encourage you to share it with your charity of choice.

Mine is the [GiveWell top charities fund](https://www.givewell.org/top-charities-fund), which does excellent research to figure out which causes can save the most human lives for the money, and puts their funds there.

Their grant to the [Against Malaria Foundation](https://www.againstmalaria.com) was shown to deliver outcomes at a cost of just $1,700 per life saved.
