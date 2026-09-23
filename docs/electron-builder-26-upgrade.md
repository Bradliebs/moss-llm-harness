<!-- markdownlint-disable-file -->
# electron-builder 25 to 26 Upgrade + Installer Checklist

Moss currently pins `electron-builder ^25.1.8` and produces a Windows NSIS
installer via `npm run dist`. This is the gated procedure to move to
electron-builder 26 and produce a signed-or-unsigned installer. It is gated
because packaging on Windows needs an elevated PowerShell session (symlink and
code-signing privileges) and, for the symlink step, Developer Mode enabled. Do
not run this autonomously.

As of 2026-09-23, `npm audit` reports high and critical advisories in the
electron-builder 25 dependency tree, including `tar`, `app-builder-lib`, and
`builder-util-runtime`. They affect packaging tooling, not production
dependencies. `npm audit --omit=dev` reports no vulnerabilities. This upgrade is
the planned remediation; do not use `npm audit fix --force` in place of it.

## Prerequisites

- Windows with Developer Mode enabled (Settings > For developers), or an elevated
  PowerShell session, so electron-builder can extract symlinked tooling.
- A clean working tree and a green `npm run typecheck` and `npm test`.
- Disk space for the unpacked app under `release/`.

## Upgrade steps

1. **Read the migration notes**
   - Review the electron-builder 26 release notes for breaking changes, especially
     around NSIS, `files` globbing, and the app-builder binary.

2. **Bump the dependency**
   - `npm install --save-dev electron-builder@^26`
   - Confirm the lockfile updates and no peer-dependency errors appear.

3. **Re-validate config**
   - Re-read `electron-builder.yml`. Confirm the whitelist still resolves:
     - `dist-electron/**/*`, `dist/**/*`, `electron/preload.cjs`, `package.json`.
   - Confirm `asar: true` and `npmRebuild: false` are still valid (no native
     modules are compiled).
   - Confirm the `win > target: nsis` and `nsis` block still parse under 26.

4. **Dry-run pack (no installer)**
   - `npm run pack` (runs `build` then `electron-builder --dir`).
   - Inspect `release/win-unpacked/`. Confirm `Moss.exe` launches and loads the
     renderer (`dist/index.html`) and preload (`electron/preload.cjs`).

5. **Build the installer**
   - `npm run dist` (runs `build` then `electron-builder --win nsis`).
   - Confirm `release/Moss-Setup-0.1.0.exe` is produced.

6. **Install + launch test**
   - Run the installer. Confirm the install-directory prompt appears
     (`allowToChangeInstallationDirectory: true`, `oneClick: false`).
   - Launch the installed app and run a short slice of the GUI smoke checklist
     (provider setup, one chat turn, one tool approval).
   - Uninstall and confirm a clean removal.

## Pass criteria

- `npm run typecheck` and `npm test` stay green after the bump.
- `npm run pack` produces a launchable unpacked app.
- `npm run dist` produces `release/Moss-Setup-${version}.exe`.
- The installed app passes a short GUI smoke slice.

## Rollback

- If 26 breaks packaging, revert the `package.json` / lockfile change to
  `electron-builder ^25.1.8` and re-run `npm install`, then `npm run dist` to
  confirm the previous installer still builds.
