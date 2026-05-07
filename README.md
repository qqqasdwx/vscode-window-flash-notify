# Window Flash Notify

Flash the matching Windows VS Code taskbar window from a terminal hook without
stealing focus.

This project uses two VS Code extensions:

- `qqqasdwx.vscode-window-flash-notify`: UI-side extension. Runs on the local
  Windows VS Code UI host and calls `FlashWindowEx`.
- `qqqasdwx.vscode-window-flash-notify-relay`: workspace-side relay. Runs where
  the workspace terminal runs, listens on `127.0.0.1`, and forwards requests to
  the UI-side command.

## Why Two Extensions

VS Code Remote has separate extension hosts. A workspace extension can listen
on the remote machine's `127.0.0.1`, while a UI extension can call Windows APIs
on the local desktop. This extension needs both abilities, so the relay and UI
parts are separate extension IDs.

## Install

Install both extensions:

```text
qqqasdwx.vscode-window-flash-notify
qqqasdwx.vscode-window-flash-notify-relay
```

In Remote SSH, WSL, Dev Container, or Vagrant workflows, install the relay in
the remote/workspace side and keep the UI extension installed locally.

## Quick Test

The relay writes `.vscode/window-flash-notify-port.json` in the workspace. Use
the `endpoints.local` URL from that file, or try the default:

```bash
curl -fsS -X POST http://127.0.0.1:7531/notify \
  -H 'Content-Type: application/json' \
  --data '{"message":"Build finished","type":"info","action":"flash"}'
```

Health check:

```bash
curl -fsS http://127.0.0.1:7531/health
```

## Codex Stop Hook Example

```bash
#!/usr/bin/env bash
set -u

payload="$(cat || true)"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null || true)"
[ -n "$cwd" ] || cwd="${PWD:-unknown}"
project="$(basename "$cwd")"

endpoint="http://127.0.0.1:7531/notify"
if [ -f "$cwd/.vscode/window-flash-notify-port.json" ]; then
  endpoint="$(jq -r '.endpoints.local // empty' "$cwd/.vscode/window-flash-notify-port.json" 2>/dev/null || true)"
  [ -n "$endpoint" ] || endpoint="http://127.0.0.1:7531/notify"
fi

curl -fsS --max-time 3 -X POST "$endpoint" \
  -H 'Content-Type: application/json' \
  --data "{\"message\":\"Codex finished: ${project}\",\"type\":\"info\",\"action\":\"flash\",\"workspaceName\":\"${project}\",\"workspacePath\":\"${cwd}\"}" \
  >/dev/null || true

printf '{"continue": true}'
```

## Request Body

```json
{
  "message": "Codex finished",
  "type": "info",
  "action": "flash",
  "workspaceName": "my-project",
  "workspacePath": "/path/to/my-project"
}
```

Fields:

- `message`: text for logs or optional internal notification.
- `type`: `info`, `warning`, or `error`.
- `action`: `flash`, `focus`, or `none`. Default is `flash`.
- `workspaceName`: optional window title match hint. Defaults to the current
  workspace name.
- `workspacePath`: optional workspace path hint. Its basename is also used for
  window title matching.
- `workspaceHints`: optional string array of extra title match hints.
- `showInternalNotification`: optional per-request override for showing a VS
  Code internal notification from the UI extension.

## Settings

UI extension settings:

- `windowFlashNotify.flashUntilForeground`: flash until the window becomes
  foreground. Default: `true`.
- `windowFlashNotify.flashCount`: number of flashes when
  `flashUntilForeground` is disabled. Default: `8`.
- `windowFlashNotify.showInternalNotification`: also show a VS Code internal
  notification. Default: `false`.

Relay extension settings:

- `windowFlashNotifyRelay.basePort`: first relay port to try. Default: `7531`.
- `windowFlashNotifyRelay.portSearchRange`: number of ports to try. Default:
  `10`.
- `windowFlashNotifyRelay.listenHost`: relay bind address. Default:
  `127.0.0.1`.
- `windowFlashNotifyRelay.authToken`: optional token required by requests.
- `windowFlashNotifyRelay.writePortFile`: write
  `.vscode/window-flash-notify-port.json`. Default: `true`.

## Notes

The UI extension intentionally focuses on Windows because Windows exposes a
stable taskbar flashing API. On non-Windows local desktops, the relay endpoint
still works, but UI-side `flash` is a no-op.

Window matching is conservative. If no visible VS Code window title matches the
workspace hints, the UI extension returns an error instead of flashing every VS
Code window.
