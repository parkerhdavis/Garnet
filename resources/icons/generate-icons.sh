#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# Icon generation script for Garnet Tauri app
# Generates all required icon sizes from source PNGs and copies them to
# every location that needs them (Tauri bundle config, frontend public/).
# Requires ImageMagick (v6 or v7) and optionally icnsutils (png2icns).

set -e

# ─── Configuration ────────────────────────────────────────────────────
# ICON_SHAPE controls the app icon shape for platform bundles.
# Options: "square", "rounded", "circle"
ICON_SHAPE="rounded"

# Corner radius percentage for "rounded" mode (0-50, where 50 = circle)
ROUNDED_PERCENT=12

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PUBLIC_DIR="$PROJECT_ROOT/apps/desktop/frontend/public"

# Source files (drop these into resources/icons/ before running).
APP_ICON="garnet-icon-fullres-bg.png"
SPLASH_DARK="garnet-icon-fullres-trans-fordark.png"
SPLASH_LIGHT="garnet-icon-fullres-trans-forlight.png"

cd "$SCRIPT_DIR"

for src in "$APP_ICON" "$SPLASH_DARK" "$SPLASH_LIGHT"; do
	if [ ! -f "$src" ]; then
		echo "Error: $src not found in $SCRIPT_DIR"
		echo "       See resources/icons/README.md for the source-file conventions."
		exit 1
	fi
done

if command -v magick &> /dev/null; then
	IM="magick"
elif command -v convert &> /dev/null; then
	IM="convert"
else
	echo "Error: ImageMagick is not installed. Please install it first:"
	echo "  Ubuntu/Debian: sudo apt install imagemagick"
	echo "  Fedora: sudo dnf install ImageMagick"
	echo "  Arch: sudo pacman -S imagemagick"
	exit 1
fi

apply_shape() {
	local input="$1" size="$2" output="$3"

	case "$ICON_SHAPE" in
		square)
			$IM "$input" -resize "${size}x${size}" "PNG32:$output"
			;;
		rounded)
			local radius=$(( size * ROUNDED_PERCENT / 100 ))
			$IM "$input" -resize "${size}x${size}" -alpha set \
				\( -size "${size}x${size}" xc:none \
				   -fill white -draw "roundrectangle 0,0,$((size-1)),$((size-1)),${radius},${radius}" \) \
				-compose DstIn -composite "PNG32:$output"
			;;
		circle)
			local half=$(( size / 2 ))
			$IM "$input" -resize "${size}x${size}" -alpha set \
				\( -size "${size}x${size}" xc:none \
				   -fill white -draw "circle ${half},${half} ${half},0" \) \
				-compose DstIn -composite "PNG32:$output"
			;;
		*)
			echo "Error: Unknown ICON_SHAPE '$ICON_SHAPE' (use square, rounded, or circle)"
			exit 1
			;;
	esac
}

# ─── Tauri bundle icons (from app icon) ─────────────────────────────────

echo "Generating Tauri bundle icons from $APP_ICON (shape: $ICON_SHAPE)..."

apply_shape "$APP_ICON" 32 32x32.png
echo "  Generated 32x32.png"

apply_shape "$APP_ICON" 128 128x128.png
echo "  Generated 128x128.png"

apply_shape "$APP_ICON" 256 "128x128@2x.png"
echo "  Generated 128x128@2x.png (256x256)"

apply_shape "$APP_ICON" 512 512x512.png
echo "  Generated 512x512.png"

# .ico for Windows (multi-size)
ICO_TMPDIR="$(mktemp -d)"
for s in 16 32 48 64 128 256; do
	apply_shape "$APP_ICON" "$s" "$ICO_TMPDIR/icon_${s}.png"
done
$IM "$ICO_TMPDIR"/icon_*.png icon.ico
rm -rf "$ICO_TMPDIR"
echo "  Generated icon.ico (multi-size)"

# .icns for macOS
if command -v png2icns &> /dev/null; then
	ICNS_TMPDIR="$(mktemp -d)"
	for s in 16 32 128 256 512; do
		apply_shape "$APP_ICON" "$s" "$ICNS_TMPDIR/icon_${s}.png"
	done
	png2icns icon.icns \
		"$ICNS_TMPDIR/icon_16.png" \
		"$ICNS_TMPDIR/icon_32.png" \
		"$ICNS_TMPDIR/icon_128.png" \
		"$ICNS_TMPDIR/icon_256.png" \
		"$ICNS_TMPDIR/icon_512.png"
	rm -rf "$ICNS_TMPDIR"
	echo "  Generated icon.icns"
else
	echo "  Skipped icon.icns (install icnsutils: sudo apt install icnsutils)"
fi

# ─── Frontend public/ assets ───────────────────────────────────────────

echo ""
echo "Copying to frontend/public/..."

mkdir -p "$PUBLIC_DIR"
cp 512x512.png "$PUBLIC_DIR/garnet-icon.png"
echo "  Copied 512x512.png -> garnet-icon.png"

cp "$SPLASH_DARK" "$PUBLIC_DIR/garnet-splash-dark.png"
echo "  Copied $SPLASH_DARK -> garnet-splash-dark.png"

cp "$SPLASH_LIGHT" "$PUBLIC_DIR/garnet-splash-light.png"
echo "  Copied $SPLASH_LIGHT -> garnet-splash-light.png"

echo ""
echo "Done! Generated Tauri bundle icons (shape: $ICON_SHAPE):"
ls -lh 32x32.png 128x128.png 128x128@2x.png 512x512.png icon.ico icon.icns 2>/dev/null
echo ""
echo "Frontend public/ contents:"
ls -lh "$PUBLIC_DIR"/garnet-*.png
