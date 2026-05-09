# Window Flash Notify Relay

[中文](README.md) | English

Window Flash Notify Relay is the workspace-side extension. It runs on the current VS Code workspace machine, listens on `127.0.0.1`, accepts `POST /notify` from scripts, and forwards the payload to the local UI-side extension.

It is normally installed together with the UI extension. Install the UI-side extension first; it declares the relay as an extension pack member:

```text
qqqasdwx.vscode-window-flash-notify
qqqasdwx.vscode-window-flash-notify-relay
```

Use it in Remote SSH, WSL, Dev Containers, Vagrant, or local workspaces where scripts need to send completion notifications.

The relay automatically converts the current workspace, remote identity, and editor context into window title-matching hints so the UI side can flash only the originating VS Code window.

## Quick Test

The relay injects `WINDOW_FLASH_NOTIFY_ENDPOINT` into VS Code integrated terminals. If the variable is missing from the current terminal, open a new VS Code terminal.

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}"
```

Send a toast and sound notification:

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}" \
  -H 'Content-Type: application/json' \
  --data '{"message":"Task finished","showToast":true,"sound":true}'
```
