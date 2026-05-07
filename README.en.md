# Window Flash Notify

[中文](README.md) | English

Window Flash Notify lets scripts, terminal tasks, remote builds, and test runs notify you by flashing the matching Windows VS Code taskbar button without stealing focus.

It is useful for:

- Long-running tasks in Remote SSH, WSL, Dev Containers, or Vagrant
- Local or remote shell hooks
- Build, test, and deployment completion notifications
- Workflows with multiple VS Code windows where only the matching window should flash

## How It Works

The project contains two VS Code extensions:

- `qqqasdwx.vscode-window-flash-notify`: the UI-side extension. It runs in the local VS Code UI extension host and calls Windows `FlashWindowEx` for the matching VS Code window.
- `qqqasdwx.vscode-window-flash-notify-relay`: the workspace-side relay. It runs on the current workspace machine, listens on `127.0.0.1`, accepts HTTP requests from local scripts, and forwards them to the UI extension via a VS Code command.

The split matches VS Code Remote's extension host model: the workspace extension can listen on the workspace machine's localhost, while the UI extension can call local Windows desktop APIs.

## Install

Install both extensions:

```text
qqqasdwx.vscode-window-flash-notify
qqqasdwx.vscode-window-flash-notify-relay
```

For Remote SSH, WSL, Dev Container, or Vagrant workflows:

- Install the UI extension locally.
- Install the Relay extension on the remote/workspace side.

For local-only workflows, both extensions can be installed locally.

## Quick Test

The relay injects this environment variable into VS Code integrated terminals:

```bash
WINDOW_FLASH_NOTIFY_ENDPOINT=http://127.0.0.1:7531/notify
```

If the variable is missing from the current terminal, open a new VS Code terminal.

The minimum call is an empty `POST` request:

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}"
```

Send a JSON body when you want to customize the log text:

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}" \
  -H 'Content-Type: application/json' \
  --data '{"message":"Task finished","type":"info","action":"flash"}'
```

Health check:

```bash
curl -fsS http://127.0.0.1:7531/health
```

## Generic Hook Example

Use this at the end of any shell hook, build script, or test script:

```bash
#!/usr/bin/env bash
set -u

cwd="${PWD:-unknown}"
project="$(basename "$cwd")"
endpoint="${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}"

curl -fsS --max-time 3 -X POST "$endpoint" \
  -H 'Content-Type: application/json' \
  --data "{\"message\":\"Finished: ${project}\"}" \
  >/dev/null || true
```

## Request Body

The request body can be omitted. An omitted body is equivalent to `{}` and defaults to `flash`.

Optional JSON example:

```json
{
  "message": "Task finished"
}
```

Fields:

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `message` | No | `"Notification received"` | Text for logs or optional VS Code internal notifications. |
| `type` | No | `"info"` | Message level. See the `type` enum below. |
| `action` | No | `"flash"` | Action to run after receiving the request. See the `action` enum below. |
| `workspaceName` | No | Current VS Code workspace name | Window title match hint. Callers usually do not need to send this; the relay fills it automatically. |
| `workspacePath` | No | First folder path in the current workspace | Workspace path match hint. Its basename is also used for title matching. Callers usually do not need to send this. |
| `workspaceHints` | No | Generated from the current workspace | Extra window title match hints. Only send this when overriding the default matching behavior. |
| `showInternalNotification` | No | UI setting `windowFlashNotify.showInternalNotification` | Also show a VS Code internal notification from the UI extension. |

`type` enum:

| Value | Meaning |
| --- | --- |
| `info` | Informational message for success, completion, or general reminders. |
| `warning` | Warning message for cases that need attention but are not necessarily failures. |
| `error` | Error message for failures or cases that need immediate attention. |

`action` enum:

| Value | Meaning |
| --- | --- |
| `flash` | Flash the matching VS Code taskbar button without stealing focus. Recommended default. |
| `focus` | Bring the matching VS Code window to the foreground. This interrupts current focus. |
| `none` | Do not run a window action; keep only logging and optional internal notification behavior. |

## Settings

UI extension:

- `windowFlashNotify.flashUntilForeground`: flash the taskbar until the VS Code window becomes foreground. Default: `true`.
- `windowFlashNotify.flashCount`: number of flashes to request when continuous flashing is disabled. Default: `8`.
- `windowFlashNotify.showInternalNotification`: also show a VS Code internal notification after receiving a relayed request. Default: `false`.

Relay extension:

- `windowFlashNotifyRelay.basePort`: first port to try when starting the workspace notification HTTP server. Default: `7531`.
- `windowFlashNotifyRelay.portSearchRange`: number of ports to try from the base port. Default: `10`.
- `windowFlashNotifyRelay.listenHost`: workspace HTTP server bind address. Default: `127.0.0.1`.
- `windowFlashNotifyRelay.authToken`: optional request token.

## Localization

The extension manifests use VS Code's standard `package.nls.json` / `package.nls.zh-cn.json` localization files. English is the default fallback, and Chinese users see localized setting descriptions and command titles.

The default README is Chinese. This file is the English documentation.

## Notes

- The UI-side flashing feature depends on the Windows taskbar API. On non-Windows local desktops, the relay endpoint still works, but `flash` is a no-op.
- `WINDOW_FLASH_NOTIFY_ENDPOINT` is injected only into VS Code integrated terminals. If an existing terminal does not have it, open a new terminal.
- Window matching is conservative. If no visible VS Code window title matches the workspace hints, the UI extension returns an error instead of flashing every VS Code window.
- `focus` actively brings the matching window to the foreground. `flash` is recommended by default because it does not interrupt focus.
