Icon generation for Garnet. `generate-icons.sh` produces every size/format Tauri's bundler expects and copies the splash images into `apps/desktop/frontend/public/`. Until a real icon source PNG lands here, `make icons` and `make build` will both fail loudly — that's intentional.

# Required source files

Drop these into this directory before running `make icons`:

| Filename | Purpose |
|:---|:---|
| `garnet-icon-fullres-bg.png` | Main app icon. Square, opaque, at least 1024×1024. Source for `.ico`, `.icns`, and the `32 / 128 / 128@2x / 512` PNGs Tauri bundles. |
| `garnet-icon-fullres-trans-fordark.png` | Transparent splash icon for dark backgrounds. Copied as `garnet-splash-dark.png` into `frontend/public/`. |
| `garnet-icon-fullres-trans-forlight.png` | Transparent splash icon for light backgrounds. Copied as `garnet-splash-light.png` into `frontend/public/`. |

Shape masking (`square` / `rounded` / `circle`) is controlled by the `ICON_SHAPE` variable at the top of `generate-icons.sh`. Default is `rounded`.

# Generated outputs

After a successful run, this directory will also contain `32x32.png`, `128x128.png`, `128x128@2x.png`, `512x512.png`, `icon.ico`, and `icon.icns` — all referenced from `apps/desktop/backend/tauri.conf.json`. These files are checked in (so CI/Tauri builds don't need ImageMagick); regenerate them whenever the source PNG changes.

# Dependencies

- **ImageMagick** (v6 `convert` or v7 `magick`) — required.
- **icnsutils** (`png2icns`) — optional; without it, `.icns` is skipped and macOS bundles fall back to the PNG icons.
