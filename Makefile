# ─── Garnet Makefile ───

.PHONY: help \
        setup install \
        dev dev-frontend down \
        build build-linux build-windows build-macos notarize check \
        lint lint-fix format typecheck test \
        icons \
        version \
        clean

# ─── OS Detection ───
ifdef OS
    ifeq ($(OS),Windows_NT)
        UNAME_S := Windows
    else
        UNAME_S := $(shell uname -s 2>/dev/null || echo Windows)
    endif
else
    UNAME_S := $(shell uname -s 2>/dev/null || echo Windows)
endif
ifneq (,$(findstring MINGW,$(UNAME_S)))
    DETECTED_OS := windows
else ifneq (,$(findstring MSYS,$(UNAME_S)))
    DETECTED_OS := windows
else ifneq (,$(findstring CYGWIN,$(UNAME_S)))
    DETECTED_OS := windows
else ifneq (,$(findstring Windows,$(UNAME_S)))
    DETECTED_OS := windows
else ifeq ($(UNAME_S),Linux)
    DETECTED_OS := linux
else ifeq ($(UNAME_S),Darwin)
    DETECTED_OS := macos
else
    DETECTED_OS := windows
endif

# ─── Paths ───
DESKTOP_DIR := apps/desktop
FRONTEND_DIR := apps/desktop/frontend
BACKEND_DIR := apps/desktop/backend

ifeq ($(DETECTED_OS),windows)
    SHELL := pwsh.exe
    .SHELLFLAGS := -NoProfile -Command
    BUN := bun
    TAURI := bunx tauri
    MKDIR := New-Item -ItemType Directory -Force -Path
    RM := Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    NULL := $$null
else
    BUN := bun
    TAURI := bunx tauri
    MKDIR := mkdir -p
    RM := rm -rf
    NULL := /dev/null
    ifeq ($(DETECTED_OS),macos)
        SED_INPLACE := sed -i ''
    else
        SED_INPLACE := sed -i
    endif
endif

# ─── Icons (sentinel) ───
ICON_SOURCE := resources/icons/garnet-icon-fullres-bg.png
ICON_SCRIPT := resources/icons/generate-icons.sh
ICON_SENTINEL := resources/icons/512x512.png

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ─── Setup ───

ifeq ($(DETECTED_OS),windows)
setup: ## Check/install Rust + Bun + system deps, then bun install
	@echo "================================================================================"
	@echo "  Garnet Setup - Installing Dependencies"
	@echo "================================================================================"
	@if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) { Write-Host "Rust not found. Install from https://rustup.rs then re-run 'make setup'."; exit 1 } else { Write-Host "Rust: $$(rustc --version)" }
	@if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Write-Host "Bun not found. Install from https://bun.sh then re-run 'make setup'."; exit 1 } else { Write-Host "Bun: $$(bun --version)" }
	@Write-Host ""
	@Write-Host "Windows system requirements for Tauri:"
	@Write-Host "  - Visual Studio C++ Build Tools"
	@Write-Host "  - WebView2 Runtime (pre-installed on Windows 10+)"
	@Write-Host "  See https://tauri.app/start/prerequisites/#windows"
	@Write-Host ""
	@Write-Host "Installing JS dependencies..."
	$(BUN) install
	@Write-Host "Setup complete"

install: setup
else
setup:
	@echo "================================================================================"
	@echo "  Garnet Setup - Installing Dependencies"
	@echo "================================================================================"
	@if ! command -v rustc >/dev/null 2>&1; then \
		echo "Rust not found. Installing via rustup..."; \
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh; \
		echo "Rust installed. Please restart your shell and re-run 'make setup'."; \
		exit 0; \
	else \
		echo "Rust: $$(rustc --version)"; \
	fi
	@if ! command -v bun >/dev/null 2>&1; then \
		echo "Bun not found. Installing..."; \
		curl -fsSL https://bun.sh/install | bash; \
		echo "Bun installed. Please restart your shell and re-run 'make setup'."; \
		exit 0; \
	else \
		echo "Bun: $$(bun --version)"; \
	fi
ifeq ($(DETECTED_OS),linux)
	@echo ""
	@echo "Checking Linux system dependencies for Tauri (build)..."
	@MISSING=""; \
	for p in libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libasound2-dev; do \
		if ! dpkg-query -W -f='$${Status}' "$$p" 2>/dev/null | grep -q "install ok installed"; then \
			MISSING="$$MISSING $$p"; \
		fi; \
	done; \
	if [ -n "$$MISSING" ]; then \
		echo "Missing build packages:$$MISSING"; \
		echo ""; \
		echo "Install with: sudo apt install$$MISSING"; \
		echo ""; \
		echo "Continuing with JS install anyway — Tauri build will fail until these land."; \
	else \
		echo "All required build packages present."; \
	fi
	@echo ""
	@echo "Checking Linux GStreamer codecs (webview media playback)..."
	@MISSING_MEDIA=""; \
	for p in gstreamer1.0-libav gstreamer1.0-plugins-good gstreamer1.0-plugins-bad; do \
		if ! dpkg-query -W -f='$${Status}' "$$p" 2>/dev/null | grep -q "install ok installed"; then \
			MISSING_MEDIA="$$MISSING_MEDIA $$p"; \
		fi; \
	done; \
	if [ -n "$$MISSING_MEDIA" ]; then \
		echo "Missing media codecs:$$MISSING_MEDIA"; \
		echo ""; \
		echo "Install with: sudo apt install$$MISSING_MEDIA"; \
		echo ""; \
		echo "Garnet will build and run without these, but video/audio playback in"; \
		echo "the asset detail view (MP4/H.264, MP3, AAC, etc.) will fail silently"; \
		echo "until they land."; \
	else \
		echo "All recommended media codecs present."; \
	fi
	@echo ""
	@echo "Checking ffmpeg + ffprobe (video thumbnails + video editor)..."
	@if ! command -v ffmpeg >/dev/null 2>&1; then \
		echo "ffmpeg not on PATH."; \
		echo ""; \
		echo "Install with: sudo apt install ffmpeg"; \
		echo ""; \
		echo "Without it, video tiles fall back to the film icon and the video editor is unavailable."; \
	else \
		echo "ffmpeg: $$(ffmpeg -version | head -1)"; \
	fi
	@if ! command -v ffprobe >/dev/null 2>&1; then \
		echo "ffprobe not on PATH (ships with ffmpeg; install the ffmpeg package)."; \
		echo "Without it, the video editor can't read duration/dimensions and won't open."; \
	else \
		echo "ffprobe: $$(ffprobe -version | head -1)"; \
	fi
else ifeq ($(DETECTED_OS),macos)
	@echo ""
	@echo "Checking macOS system dependencies..."
	@if ! xcode-select -p >/dev/null 2>&1; then \
		echo "Xcode Command Line Tools not installed."; \
		echo "Install with: xcode-select --install"; \
	else \
		echo "Xcode Command Line Tools installed."; \
	fi
endif
	@echo ""
	@echo "Installing JS dependencies..."
	@$(BUN) install
	@echo "Setup complete"

install: setup
endif

# ─── Service ───

ifeq ($(DETECTED_OS),windows)
dev: ## Start Tauri dev server (frontend + Rust hot-reload)
	@echo "Starting Tauri development server (frontend + Rust)..."
	cd $(BACKEND_DIR); $(TAURI) dev

dev-frontend: ## Start Bun dev server only (rapid UI iteration)
	@echo "Starting Bun dev server only (rapid UI iteration)..."
	cd $(DESKTOP_DIR); $(BUN) run dev

down: ## Stop any running dev server
	@echo "Stopping dev server..."
	@echo "On Windows, close the terminal running the dev server or use Task Manager."
else
dev:
	@echo "Starting Tauri development server (frontend + Rust)..."
	@EXISTING_PID=$$(lsof -ti :5173 2>/dev/null); \
	if [ -n "$$EXISTING_PID" ]; then \
		echo "  -> WARNING: Port 5173 in use (pid $$EXISTING_PID) — killing to free port"; \
		kill $$EXISTING_PID 2>/dev/null || true; \
		sleep 1; \
	fi
	@echo "  -> Starting Tauri (frontend dev server started by Tauri via beforeDevCommand)..."
	@cd $(BACKEND_DIR) && $(TAURI) dev

down:
	@echo "Stopping Garnet dev server..."
	@echo "  -> Checking port 5173..."
	@PORT_PID=$$(lsof -ti :5173 2>/dev/null); \
	if [ -n "$$PORT_PID" ]; then \
		kill $$PORT_PID 2>/dev/null || true; \
		echo "  -> Killed process on port 5173 (pid $$PORT_PID)"; \
	else \
		echo "  -> No dev server running"; \
	fi

dev-frontend:
	@echo "Starting Bun dev server only (rapid UI iteration)..."
	@cd $(DESKTOP_DIR) && $(BUN) run dev
endif

# ─── Icons ───

$(ICON_SENTINEL): $(ICON_SOURCE) $(ICON_SCRIPT)
	@echo "Regenerating icons..."
	@bash $(ICON_SCRIPT)

icons: $(ICON_SENTINEL) ## Regenerate desktop app icon set from the master PNG

# ─── Build ───

ifeq ($(DETECTED_OS),windows)
build: icons ## Build for current platform (auto-detects OS)
	@echo "Building Windows installers (.msi, .exe)..."
	@echo "  -> Building frontend..."
	cd $(DESKTOP_DIR); $(BUN) run build
	@echo "  -> Building Tauri app for Windows..."
	$$env:PATH = "$$env:USERPROFILE\.cargo\bin;$$env:PATH"; cd $(BACKEND_DIR); $(TAURI) build
	@echo ""
	@echo "Windows build complete!"
else
build: icons
ifeq ($(DETECTED_OS),linux)
	@$(MAKE) build-linux
else ifeq ($(DETECTED_OS),macos)
	@$(MAKE) build-macos
endif
endif

ifeq ($(DETECTED_OS),windows)
build-linux: ## Build Linux installers (.deb, .rpm, AppImage)
	@echo "ERROR: Linux builds must be run on Linux"
	@exit 1

build-windows: icons ## Build Windows installers (.msi, .exe)
	@echo "Building Windows installers (.msi, .exe)..."
	@echo "  -> Building frontend..."
	cd $(DESKTOP_DIR); $(BUN) run build
	@echo "  -> Building Tauri app for Windows..."
	$$env:PATH = "$$env:USERPROFILE\.cargo\bin;$$env:PATH"; cd $(BACKEND_DIR); $(TAURI) build
	@echo ""
	@echo "Windows build complete!"

build-macos: ## Build macOS installers (.dmg, .app)
	@echo "ERROR: macOS builds must be run on macOS"
	@exit 1
else
build-linux: icons
	@echo "Building Linux installers (.deb, .rpm, AppImage)..."
	@echo "  -> Building frontend..."
	@cd $(DESKTOP_DIR) && $(BUN) run build
	@echo "  -> Building Tauri app for Linux..."
	@cd $(BACKEND_DIR) && $(TAURI) build
	@echo ""
	@echo "Linux build complete!"
	@echo ""
	@echo "Build outputs in ./target/release/bundle/:"
	@echo "  - AppImage: ./target/release/bundle/appimage/"
	@echo "  - Debian:   ./target/release/bundle/deb/"
	@echo "  - RPM:      ./target/release/bundle/rpm/"

build-windows:
	@echo "ERROR: Windows builds must be run on Windows"
	@exit 1

build-macos: icons
	@echo "Building macOS installers (.dmg, .app)..."
	@if [ -f .env ]; then \
		echo "  -> Loading signing config from .env"; \
	else \
		echo "  -> WARNING: No .env file found — build will not be signed"; \
		echo "     Copy .env.example to .env and fill in your Apple credentials"; \
	fi
	@echo "  -> Building frontend..."
	@cd $(DESKTOP_DIR) && $(BUN) run build
	@echo "  -> Building Tauri app for macOS..."
	@if [ -f .env ]; then \
		. ./.env && \
		( unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID && cd $(BACKEND_DIR) && $(TAURI) build ); \
	else \
		cd $(BACKEND_DIR) && $(TAURI) build; \
	fi
	@if [ -f .env ]; then \
		. ./.env && \
		echo "" && \
		echo "Re-signing with hardened runtime and secure timestamp..." && \
		echo "  (Tauri's bundler omits --timestamp; re-signing to fix)" && \
		codesign --force --options runtime --timestamp \
			--entitlements $(BACKEND_DIR)/entitlements.plist \
			--sign "$$APPLE_SIGNING_IDENTITY" \
			./target/release/bundle/macos/Garnet.app/Contents/MacOS/garnet && \
		codesign --force --options runtime --timestamp \
			--entitlements $(BACKEND_DIR)/entitlements.plist \
			--sign "$$APPLE_SIGNING_IDENTITY" \
			./target/release/bundle/macos/Garnet.app && \
		echo "  -> Re-signed .app bundle" && \
		echo "" && \
		echo "Rebuilding DMG from re-signed .app..." && \
		VERSION=$$(grep '^version = ' $(BACKEND_DIR)/Cargo.toml | head -1 | sed 's/version = "\(.*\)"/\1/') && \
		ARCH=$$(uname -m | sed 's/arm64/aarch64/') && \
		DMG_NAME="Garnet_$${VERSION}_$${ARCH}.dmg" && \
		DMG_PATH="./target/release/bundle/dmg/$${DMG_NAME}" && \
		rm -f "$${DMG_PATH}" && \
		hdiutil create -volname "Garnet" \
			-srcfolder ./target/release/bundle/macos/Garnet.app \
			-ov -format UDZO \
			"$${DMG_PATH}" && \
		codesign --force --timestamp \
			--sign "$$APPLE_SIGNING_IDENTITY" \
			"$${DMG_PATH}" && \
		echo "  -> DMG rebuilt and signed: $${DMG_PATH}" && \
		echo "" && \
		echo "Verifying code signature..." && \
		codesign --verify --deep --strict ./target/release/bundle/macos/Garnet.app && \
		echo "  -> Code signature: OK"; \
	fi
	@echo ""
	@echo "macOS build complete!"
	@echo ""
	@echo "Build outputs in ./target/release/bundle/:"
	@echo "  - DMG:  ./target/release/bundle/dmg/"
	@echo "  - App:  ./target/release/bundle/macos/"
	@if [ -f .env ]; then \
		echo "" && \
		echo "To notarize, run: make notarize"; \
	fi

notarize: ## Submit macOS build for Apple notarization
	@if [ ! -f .env ]; then \
		echo "ERROR: .env file required for notarization"; \
		echo "  Copy .env.example to .env and fill in your Apple credentials"; \
		exit 1; \
	fi
	@. ./.env && \
	VERSION=$$(grep '^version = ' $(BACKEND_DIR)/Cargo.toml | head -1 | sed 's/version = "\(.*\)"/\1/') && \
	ARCH=$$(uname -m | sed 's/arm64/aarch64/') && \
	DMG_NAME="Garnet_$${VERSION}_$${ARCH}.dmg" && \
	DMG_PATH="./target/release/bundle/dmg/$${DMG_NAME}" && \
	if [ ! -f "$${DMG_PATH}" ]; then \
		echo "ERROR: DMG not found at $${DMG_PATH}"; \
		echo "  Run 'make build-macos' first"; \
		exit 1; \
	fi && \
	echo "Submitting $${DMG_NAME} for notarization..." && \
	xcrun notarytool submit "$${DMG_PATH}" \
		--apple-id "$$APPLE_ID" \
		--password "$$APPLE_PASSWORD" \
		--team-id "$$APPLE_TEAM_ID" \
		--wait && \
	echo "" && \
	echo "Stapling notarization ticket..." && \
	xcrun stapler staple "$${DMG_PATH}" && \
	echo "  -> Notarization complete: $${DMG_PATH}" && \
	echo "" && \
	echo "Verifying Gatekeeper assessment..." && \
	spctl --assess --type open --context context:primary-signature "$${DMG_PATH}" 2>&1 && \
	echo "  -> Gatekeeper: OK"
endif

ifeq ($(DETECTED_OS),windows)
check: ## Run Rust compiler checks without building
	@echo "Running Rust compiler checks..."
	cd $(BACKEND_DIR); cargo check
	@echo "Rust checks passed"
else
check:
	@echo "Running Rust compiler checks..."
	@cd $(BACKEND_DIR) && cargo check
	@echo "Rust checks passed"
endif

# ─── Quality ───

ifeq ($(DETECTED_OS),windows)
lint: ## Run Biome linter and Rust clippy
	@echo "Linting frontend code..."
	$(BUN)x biome check .
	@echo "Linting Rust code..."
	cd $(BACKEND_DIR); cargo clippy -- -D warnings
	@echo "Lint complete"

lint-fix: ## Run Biome linter with auto-fix
	@echo "Fixing frontend lint issues..."
	$(BUN)x biome check --write .
	@echo "Lint fix complete"

format: ## Format code with Biome and rustfmt
	@echo "Formatting frontend code..."
	$(BUN)x biome format --write .
	@echo "Formatting Rust code..."
	cd $(BACKEND_DIR); cargo fmt
	@echo "Format complete"

typecheck: ## Run TypeScript type checking
	@echo "Running TypeScript type checking..."
	cd $(DESKTOP_DIR); $(BUN) run typecheck
	@echo "Type check passed"

test: ## Run Rust and frontend tests
	@echo "Running Rust tests..."
	cd $(BACKEND_DIR); cargo test
	@echo "Running frontend tests..."
	cd $(DESKTOP_DIR); $(BUN) test
	@echo "Tests complete"
else
lint:
	@echo "Linting frontend code..."
	@$(BUN)x biome check .
	@echo "Linting Rust code..."
	@cd $(BACKEND_DIR) && cargo clippy -- -D warnings
	@echo "Lint complete"

lint-fix:
	@echo "Fixing frontend lint issues..."
	@$(BUN)x biome check --write .
	@echo "Lint fix complete"

format:
	@echo "Formatting frontend code..."
	@$(BUN)x biome format --write .
	@echo "Formatting Rust code..."
	@cd $(BACKEND_DIR) && cargo fmt
	@echo "Format complete"

typecheck:
	@echo "Running TypeScript type checking..."
	@cd $(DESKTOP_DIR) && $(BUN) run typecheck
	@echo "Type check passed"

test:
	@echo "Running Rust tests..."
	@cd $(BACKEND_DIR) && cargo test
	@echo "Running frontend tests..."
	@cd $(DESKTOP_DIR) && $(BUN) test
	@echo "Tests complete"
endif

# ─── Versioning ───

ifeq ($(DETECTED_OS),windows)
version: ## Show or set version (use V=X.Y.Z to set)
ifndef V
	@echo "Current version:"
	@cd $(BACKEND_DIR); (Select-String -Path Cargo.toml -Pattern '^version = "(.+)"').Matches.Groups[1].Value
else
	@echo "Updating version to $(V)..."
	@(Get-Content $(BACKEND_DIR)\Cargo.toml -Raw) -replace '(?m)^version = ".*"', 'version = "$(V)"' | Set-Content $(BACKEND_DIR)\Cargo.toml -NoNewline
	@(Get-Content $(BACKEND_DIR)\tauri.conf.json -Raw) -replace '"version": ".*"', '"version": "$(V)"' | Set-Content $(BACKEND_DIR)\tauri.conf.json -NoNewline
	@(Get-Content $(DESKTOP_DIR)\package.json -Raw) -replace '"version": ".*"', '"version": "$(V)"' | Set-Content $(DESKTOP_DIR)\package.json -NoNewline
	@(Get-Content package.json -Raw) -replace '"version": ".*"', '"version": "$(V)"' | Set-Content package.json -NoNewline
	@echo "  -> $(BACKEND_DIR)/Cargo.toml"
	@echo "  -> $(BACKEND_DIR)/tauri.conf.json"
	@echo "  -> $(DESKTOP_DIR)/package.json"
	@echo "  -> package.json (root)"
	@echo ""
	@echo "Version updated to $(V)"
endif
else
version:
ifndef V
	@echo "Current version: $$(grep '^version = ' $(BACKEND_DIR)/Cargo.toml | head -1 | sed 's/version = "\(.*\)"/\1/')"
else
	@echo "Updating version to $(V)..."
	@$(SED_INPLACE) 's/^version = ".*"/version = "$(V)"/' $(BACKEND_DIR)/Cargo.toml
	@$(SED_INPLACE) 's/"version": ".*"/"version": "$(V)"/' $(BACKEND_DIR)/tauri.conf.json
	@$(SED_INPLACE) 's/"version": ".*"/"version": "$(V)"/' $(DESKTOP_DIR)/package.json
	@$(SED_INPLACE) 's/"version": ".*"/"version": "$(V)"/' package.json
	@echo "  -> $(BACKEND_DIR)/Cargo.toml"
	@echo "  -> $(BACKEND_DIR)/tauri.conf.json"
	@echo "  -> $(DESKTOP_DIR)/package.json"
	@echo "  -> package.json (root)"
	@echo ""
	@echo "Version updated to $(V)"
endif
endif

# ─── Maintenance ───

ifeq ($(DETECTED_OS),windows)
clean: ## Remove build artifacts and dependencies
	@echo "Cleaning build artifacts..."
	if (Test-Path node_modules) { Remove-Item -Recurse -Force node_modules }
	if (Test-Path $(FRONTEND_DIR)\dist) { Remove-Item -Recurse -Force $(FRONTEND_DIR)\dist }
	if (Test-Path target) { Remove-Item -Recurse -Force target }
	@echo "Cleanup complete"
else
clean:
	@echo "Cleaning build artifacts..."
	@$(RM) node_modules
	@$(RM) $(FRONTEND_DIR)/dist
	@$(RM) target
	@echo "Cleanup complete"
endif

.DEFAULT_GOAL := help
