# Window Flash Notify

[中文](README.md) | English

Window Flash Notify lets scripts, terminal tasks, remote builds, and test runs notify you by flashing the matching Windows VS Code taskbar button. The default behavior does not steal focus.

Common use cases:

- Long-running tasks in Remote SSH, WSL, Dev Containers, or Vagrant workspaces
- Local or remote shell hooks, build scripts, and test scripts
- Workflows with multiple VS Code windows where only the originating window should notify you
- Automation that needs optional sound or Windows toast notifications

## Features

- Flash the matching VS Code taskbar button without interrupting your current focus.
- Supports `flash`, `focus`, and `none` actions.
- Optional Windows system sound and native toast notifications.
- Clicking a toast attempts to return to the originating VS Code window.
- Supports VS Code Remote workflows through a workspace-side relay.
- The relay injects `WINDOW_FLASH_NOTIFY_ENDPOINT` into VS Code integrated terminals.
- The `/health` endpoint reports relay and UI extension versions for diagnostics.

## Installation

This project contains two extensions:

- `qqqasdwx.vscode-window-flash-notify`: the UI extension, installed in the local VS Code UI.
- `qqqasdwx.vscode-window-flash-notify-relay`: the workspace relay, installed where your scripts actually run.

Install the UI extension first. The UI extension declares the relay in its extension pack. In remote windows, it also checks whether the relay is missing or outdated and prompts you to install or update it. After installing or updating the relay, reload the window so the relay can activate and inject the terminal environment variable.

For local-only workflows, both extensions can be installed locally. For Remote SSH, WSL, Dev Containers, Vagrant, and similar workflows, the UI extension runs locally and the relay runs on the remote/workspace side.

## Quick Start

After the relay starts, it injects this environment variable into VS Code integrated terminals:

```bash
WINDOW_FLASH_NOTIFY_ENDPOINT=http://127.0.0.1:7531/notify
```

If the current terminal does not have the variable, open a new VS Code integrated terminal. If the default port is busy, the relay tries later ports, so scripts should prefer the environment variable instead of hard-coding `7531`.

Send an empty `POST` request to trigger the default flash action:

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}"
```

Send JSON when you want to customize the message or behavior:

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}" \
  -H 'Content-Type: application/json' \
  --data '{"message":"Task finished","type":"info","action":"flash"}'
```

Check the relay endpoint, UI extension status, and versions:

```bash
endpoint="${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}"
curl -fsS "${endpoint%/notify}/health"
```

## Script Example

Use this at the end of a build, test, or deployment script:

```bash
#!/usr/bin/env bash
set -u

cwd="${PWD:-unknown}"
project="$(basename "$cwd")"
endpoint="${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}"

curl -fsS --max-time 3 -X POST "$endpoint" \
  -H 'Content-Type: application/json' \
  --data "{\"message\":\"Finished: ${project}\",\"action\":\"flash\"}" \
  >/dev/null || true
```

Example with sound and Windows toast enabled:

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}" \
  -H 'Content-Type: application/json' \
  --data '{"message":"Build finished","type":"info","action":"flash","sound":true,"showToast":true,"toastTimeout":0}'
```

`toastTimeout: 0` leaves the toast expiration unset and lets Windows use its default behavior.

## Request API

The `POST /notify` body can be omitted. An omitted body is equivalent to `{}` and defaults to `flash`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `title` | `string` | `"<workspace> - Window Flash Notify"` | Windows toast title. |
| `message` | `string` | `"Notification received"` | Notification body text. |
| `type` | `"info" \| "warning" \| "error"` | `"info"` | Message level. When sound is enabled, this selects the Windows system sound. |
| `action` | `"flash" \| "focus" \| "none"` | `"flash"` | Window action to run after receiving the request. |
| `workspaceName` | `string` | Current VS Code workspace name | Window matching hint. Usually filled by the relay. |
| `workspacePath` | `string` | First folder path in the current workspace | Window matching hint. Usually filled by the relay. |
| `workspaceHints` | `string[]` | Generated from the current workspace | Additional window matching hints. Use only when overriding the default matching behavior. |
| `sound` | `boolean` | `windowFlashNotify.soundEnabled` | Play a Windows system sound. |
| `showToast` | `boolean` | `windowFlashNotify.showToast` | Show a Windows toast notification. |
| `toastTimeout` | `number` | `windowFlashNotify.toastTimeout` | Toast expiration timeout in seconds. Set to `0` to leave expiration unset. |

`action` values:

| Value | Behavior |
| --- | --- |
| `flash` | Flash the matching VS Code taskbar button without stealing focus. Recommended default. |
| `focus` | Bring the matching VS Code window to the foreground. This changes current focus. |
| `none` | Do not run a window action. Optional sound and toast behavior still apply. |

If you configure a relay authentication token, include it as a header or query parameter:

```bash
curl -fsS -X POST "$WINDOW_FLASH_NOTIFY_ENDPOINT" \
  -H 'Content-Type: application/json' \
  -H 'X-Window-Flash-Token: your-token' \
  --data '{"message":"Task finished"}'
```

## Settings

UI extension:

| Setting | Default | Description |
| --- | --- | --- |
| `windowFlashNotify.flashUntilForeground` | `true` | Keep flashing the taskbar button until the VS Code window becomes foreground. |
| `windowFlashNotify.flashCount` | `8` | Number of flashes to request when continuous flashing is disabled. |
| `windowFlashNotify.soundEnabled` | `false` | Play a Windows system sound by default after receiving a request. |
| `windowFlashNotify.showToast` | `false` | Show a Windows toast notification by default after receiving a request. |
| `windowFlashNotify.toastTimeout` | `15` | Toast expiration timeout in seconds. Set to `0` to leave expiration unset. |
| `windowFlashNotify.autoInstallRelay` | `true` | In remote windows, prompt to install or update the relay when it is missing or outdated. |

Relay extension:

| Setting | Default | Description |
| --- | --- | --- |
| `windowFlashNotifyRelay.basePort` | `7531` | First port to try for the relay HTTP server. |
| `windowFlashNotifyRelay.portSearchRange` | `10` | Number of ports to try, starting from `basePort`. |
| `windowFlashNotifyRelay.listenHost` | `127.0.0.1` | Bind address for the relay HTTP server. |
| `windowFlashNotifyRelay.authToken` | `""` | Optional token. When set, requests must include `X-Window-Flash-Token` or a `token` query parameter. |

## Commands

UI extension:

- `Window Flash Notify: Test UI Flash`: send one UI-side test flash.
- `Window Flash Notify: Diagnose Windows Targeting`: print visible VS Code windows, process chains, and the selected target to the output panel.
- `Window Flash Notify: Install Relay in Remote Window`: manually check and install or update the relay in the current remote window.

Relay extension:

- `Window Flash Notify Relay: Copy Curl Command`: copy a curl example for the current workspace.
- `Window Flash Notify Relay: Test Flash`: send one test notification through the relay.

## Platform Notes

- Window flashing, focus, sound, and toast behavior require a local Windows desktop.
- On non-Windows local desktops, the relay endpoint can run, but Windows taskbar flashing is not available.
- `focus` actively changes the foreground window. Use the default `flash` action when you do not want to interrupt your current work.
- Window targeting uses the VS Code process chain and current workspace hints. If multiple windows cannot be distinguished safely, the extension avoids flashing every VS Code window as a fallback.
- Clicking a toast attempts to return to the originating VS Code window. Windows may take a short moment to start the protocol handler.

## Troubleshooting

- `WINDOW_FLASH_NOTIFY_ENDPOINT` is missing: make sure the relay is installed and enabled, then open a new VS Code integrated terminal.
- `/health` is not reachable: make sure the relay is installed on the current workspace/remote side and reload the window.
- Nothing flashes: make sure the local VS Code UI is running on a Windows desktop and the request uses `action: "flash"`.
- The wrong window is notified: run `Window Flash Notify: Diagnose Windows Targeting` and inspect the output panel. Avoid opening multiple VS Code windows with identical titles when possible.
- Toasts do not appear: check Windows notification settings, Focus Assist, organization policies, and VS Code notification settings.

## Security

The relay binds to `127.0.0.1` by default and is intended for scripts running on the same workspace machine. Do not expose `windowFlashNotifyRelay.listenHost` to external networks unless you explicitly need that behavior. If you do expose it, set `windowFlashNotifyRelay.authToken` and restrict network access.

## License

MIT
