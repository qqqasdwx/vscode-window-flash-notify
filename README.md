# Window Flash Notify

Flash the matching VS Code window from a terminal, SSH session, VM, or
background script without stealing focus.

The extension is designed for workflows where long-running tools finish in a
remote shell and you want the Windows taskbar button for the right VS Code
window to flash. For example: Windows host, Vagrant VM, Remote SSH, VS Code
terminal, and Codex CLI hooks.

## What It Does

- Starts a small HTTP server from the VS Code UI extension host.
- Writes `.vscode/window-flash-notify-port.json` in the current workspace.
- Accepts `POST /notify` requests from local scripts or a VM.
- On Windows, calls `FlashWindowEx` for the matching VS Code window.
- Does not bring VS Code to the foreground unless the request asks for
  `"action": "focus"`.

## Quick Test From A Vagrant VM

When VS Code runs on the Windows host and your shell runs inside a typical
Vagrant/VirtualBox VM, the host is usually reachable at `10.0.2.2`.

```bash
curl -fsS -X POST http://10.0.2.2:7531/notify \
  -H 'Content-Type: application/json' \
  --data '{"message":"Build finished","type":"info","action":"flash"}'
```

If another VS Code window already uses port `7531`, inspect:

```bash
cat .vscode/window-flash-notify-port.json
```

Use the `endpoints.gateway` URL from that file.

## Codex Stop Hook Example

```bash
#!/usr/bin/env bash
set -u

payload="$(cat || true)"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null || true)"
[ -n "$cwd" ] || cwd="${PWD:-unknown}"
project="$(basename "$cwd")"

endpoint="http://10.0.2.2:7531/notify"
if [ -f "$cwd/.vscode/window-flash-notify-port.json" ]; then
  endpoint="$(jq -r '.endpoints.gateway // empty' "$cwd/.vscode/window-flash-notify-port.json" 2>/dev/null || true)"
  [ -n "$endpoint" ] || endpoint="http://10.0.2.2:7531/notify"
fi

curl -fsS --max-time 3 -X POST "$endpoint" \
  -H 'Content-Type: application/json' \
  --data "{\"message\":\"Codex finished: ${project}\",\"type\":\"info\",\"action\":\"flash\"}" \
  >/dev/null || true

printf '{"continue": true}'
```

## Request Body

```json
{
  "message": "Codex finished",
  "type": "info",
  "action": "flash",
  "workspaceName": "my-project"
}
```

Fields:

- `message`: text for logs or optional internal notification.
- `type`: `info`, `warning`, or `error`.
- `action`: `flash`, `focus`, or `none`. Default is `flash`.
- `workspaceName`: optional window title match hint. Defaults to the current
  workspace name.
- `showInternalNotification`: optional per-request override for showing a VS
  Code internal notification.

## Settings

- `windowFlashNotify.basePort`: first port to try. Default: `7531`.
- `windowFlashNotify.portSearchRange`: number of ports to try. Default: `10`.
- `windowFlashNotify.listenHost`: bind address. Default: `127.0.0.1`.
- `windowFlashNotify.gatewayHost`: guest-to-host address written to the port
  file. Default: `10.0.2.2`.
- `windowFlashNotify.authToken`: optional token required by requests.
- `windowFlashNotify.flashUntilForeground`: flash until the window becomes
  foreground. Default: `true`.
- `windowFlashNotify.showInternalNotification`: also show a VS Code internal
  notification. Default: `false`.

## Notes

This extension intentionally focuses on Windows because Windows exposes a
stable taskbar flashing API. On non-Windows platforms the HTTP endpoint still
works, but `flash` is a no-op.
