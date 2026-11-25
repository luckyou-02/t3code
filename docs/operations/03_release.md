# Windows Build Runbook

This fork has no release workflows. Installers are built locally on the Windows machine that uses them, following the prerequisites in [development](./00_development.md#windows-installer-prerequisites).

## Build the installer

```powershell
vp run dist:desktop:win:x64
```

Use `dist:desktop:win:arm64` on ARM64. Installers are unsigned unless `--signed` is passed with signing credentials configured.

## WSL runtime

Windows packages the bundled server and its unpacked native modules in `resources/server.asar` (+ `server.asar.unpacked`). The WSL backend additionally needs the matching-architecture Linux CLI archive, embedded as `resources/wsl-runtime.tar.gz` + SHA-256 sidecar:

1. Inside WSL, build the archive: `node scripts/build-cli-archive.ts --platform linux --arch x64 --version <version>` (written to `release-cli/`).
2. Pass it to the Windows build with `--wsl-runtime <path>` (or `T3CODE_DESKTOP_WSL_RUNTIME`).

Avoid whole-package smart unpacking: it inflates unpacked file counts and NSIS differential blockmaps. `scripts/build-desktop-artifact.ts` enforces the structural, native-load, and WSL archive checks at build time.

## Invariants

- **Node pin:** `engines.node` in root `package.json` must stay exact; Node SEA builds reject mismatches.
- **Launch fixture:** `scripts/fixtures/desktop-launch` is intentionally an old SQLite snapshot that verifies forward migrations on packaged builds. Never regenerate it on schema changes.
