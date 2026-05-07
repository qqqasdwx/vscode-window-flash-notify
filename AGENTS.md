# Repository Guidelines

## Project Structure & Module Organization

This repository contains two VS Code extensions. The root package is the UI-side extension (`vscode-window-flash-notify`) and `relay/` is the workspace-side relay extension. Source code lives in `src/extension.ts` and `relay/src/extension.ts`; compiled output is emitted to `out/` directories and should not be committed. Localization files are `package.nls.json` and `package.nls.zh-cn.json` in each package. User-facing documentation is maintained in both `README.md` and `README.en.md`.

## Build, Test, and Development Commands

Run commands from the repository root unless noted otherwise:

- `npm ci`: install pinned development dependencies.
- `npm run compile`: compile both the UI and relay extensions.
- `npm run compile:ui`: compile only the root extension.
- `npm run compile:relay`: compile only `relay/`.
- `npm run check`: run TypeScript type checks for both extensions without emitting files.
- `npm run watch`: watch and compile the root extension during local development.
- `npm run package`: create VSIX packages for both extensions with `vsce`.

There is currently no automated test script. Use `npm run check` as the required validation before submitting changes.

## Coding Style & Naming Conventions

Use TypeScript with `strict` mode enabled, CommonJS modules, and ES2022 targets. Keep two-space indentation, double quotes, and semicolons, matching the existing files. Prefer explicit interfaces and narrow union types for command payloads, configuration, and API responses. VS Code command IDs use the existing namespaces: `windowFlashNotify.*` for UI commands and `windowFlashNotifyRelay.*` for relay commands.

## Testing Guidelines

No test framework is configured yet. For behavioral changes, manually validate in VS Code Extension Development Host where possible, including Windows flash/focus behavior and relay HTTP endpoints (`/health`, `/notify`). If adding tests later, keep them close to the relevant extension and document the new command in `package.json`.

## Commit & Pull Request Guidelines

Recent commits use concise imperative messages, for example `Allow relay activation without UI dependency` and `Document notification request fields`. Follow that style: describe the change, not the process. Pull requests should include a short summary, validation performed (`npm run check`, manual VS Code testing), linked issues when available, and screenshots or terminal output for user-facing behavior changes.

## Security & Configuration Tips

Do not commit marketplace tokens, real auth tokens, generated VSIX files, or `out/` build artifacts. Treat `windowFlashNotifyRelay.authToken` and `VSCE_PAT` as secrets. Keep relay defaults bound to `127.0.0.1` unless a change intentionally expands network exposure and documents the risk.
