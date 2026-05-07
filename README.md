# Window Flash Notify

从终端 hook 通知本地 Windows VS Code 窗口闪烁任务栏图标，不自动抢焦点。

Flash the matching Windows VS Code taskbar window from terminal hooks without
stealing focus.

## 工作方式

这个项目由两个 VS Code 扩展组成：

- `qqqasdwx.vscode-window-flash-notify`：UI 端扩展。运行在本地 Windows VS Code UI host，负责调用 `FlashWindowEx` 闪烁窗口。
- `qqqasdwx.vscode-window-flash-notify-relay`：workspace 端 relay。运行在终端所在的 workspace 机器，监听 `127.0.0.1`，再把请求转发给 UI 端命令。

VS Code Remote 会把扩展分到不同 extension host。workspace 扩展能监听远端机器的 `127.0.0.1`，UI 扩展能调用本地 Windows API，所以这里拆成两个扩展 ID。

## 安装

安装这两个扩展：

```text
qqqasdwx.vscode-window-flash-notify
qqqasdwx.vscode-window-flash-notify-relay
```

Remote SSH、WSL、Dev Container、Vagrant 这类场景下，UI 端留在本地 VS Code，relay 安装到远端/workspace 侧。纯本地场景也可以两个都装在本地。

## 快速测试

relay 会在 workspace 写入 `.vscode/window-flash-notify-port.json`。优先使用里面的 `endpoints.local`，默认通常是：

```bash
curl -fsS -X POST http://127.0.0.1:7531/notify \
  -H 'Content-Type: application/json' \
  --data '{"message":"Build finished","type":"info","action":"flash"}'
```

健康检查：

```bash
curl -fsS http://127.0.0.1:7531/health
```

## Codex Stop Hook 示例

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

## 请求体

```json
{
  "message": "Codex finished",
  "type": "info",
  "action": "flash",
  "workspaceName": "my-project",
  "workspacePath": "/path/to/my-project"
}
```

字段说明：

- `message`：日志或可选 VS Code 内部通知文本。Text for logs or optional internal notifications.
- `type`：`info`、`warning` 或 `error`。`info`, `warning`, or `error`.
- `action`：`flash`、`focus` 或 `none`，默认 `flash`。`flash`, `focus`, or `none`; default is `flash`.
- `workspaceName`：可选窗口标题匹配提示，默认当前 workspace 名称。Optional window title match hint; defaults to the current workspace name.
- `workspacePath`：可选 workspace 路径提示，basename 也会用于匹配窗口标题。Optional workspace path hint; its basename is also used for matching.
- `workspaceHints`：可选额外窗口标题匹配字符串数组。Optional string array of extra title match hints.
- `showInternalNotification`：可选，控制 UI 端是否显示 VS Code 内部通知。Optional override for showing a VS Code internal notification from the UI extension.

## 设置项

UI 端设置：

- `windowFlashNotify.flashUntilForeground`：持续闪烁直到窗口回到前台。Flash until the window becomes foreground. 默认/default: `true`.
- `windowFlashNotify.flashCount`：关闭持续闪烁时的闪烁次数。Number of flashes when continuous flashing is disabled. 默认/default: `8`.
- `windowFlashNotify.showInternalNotification`：收到 relay 请求后同时显示 VS Code 内部通知。Also show a VS Code internal notification after receiving a relayed request. 默认/default: `false`.

Relay 设置：

- `windowFlashNotifyRelay.basePort`：relay 起始监听端口。First relay port to try. 默认/default: `7531`.
- `windowFlashNotifyRelay.portSearchRange`：从起始端口开始尝试的端口数量。Number of ports to try from the base port. 默认/default: `10`.
- `windowFlashNotifyRelay.listenHost`：relay 绑定地址。Relay bind address. 默认/default: `127.0.0.1`.
- `windowFlashNotifyRelay.authToken`：可选请求 token。Optional request token.
- `windowFlashNotifyRelay.writePortFile`：是否写入 `.vscode/window-flash-notify-port.json`。Write `.vscode/window-flash-notify-port.json`. 默认/default: `true`.

## 注意事项

UI 端主要面向 Windows，因为 Windows 提供稳定的任务栏闪烁 API。非 Windows 本地桌面也能使用 relay endpoint，但 UI 端 `flash` 会是 no-op。

窗口匹配是保守的：如果没有任何可见 VS Code 窗口标题匹配 workspace hints，UI 端会返回错误，不会退回到“闪烁所有 VS Code 窗口”。

## English Quick Reference

Install both extensions:

- `qqqasdwx.vscode-window-flash-notify`: local UI extension that flashes the Windows VS Code taskbar window.
- `qqqasdwx.vscode-window-flash-notify-relay`: workspace relay that listens on `127.0.0.1` and forwards requests to the UI extension.

Test from the workspace terminal:

```bash
curl -fsS -X POST http://127.0.0.1:7531/notify \
  -H 'Content-Type: application/json' \
  --data '{"message":"Build finished","type":"info","action":"flash"}'
```

Use `.vscode/window-flash-notify-port.json` if the relay chooses a different port.
