# Window Flash Notify

中文 | [English](README.en.md)

Window Flash Notify 让脚本、终端任务、远端构建、测试流程在结束时提醒你：让对应的 Windows VS Code 窗口在任务栏闪烁，但不自动抢焦点。

它适合这些场景：

- Remote SSH、WSL、Dev Container、Vagrant 中的长任务完成提醒
- 本地或远端 shell hook
- 构建、测试、部署脚本结束后提醒
- 多个 VS Code 窗口同时打开时，只提醒匹配的窗口

## 工作方式

项目包含两个 VS Code 扩展：

- `qqqasdwx.vscode-window-flash-notify`：UI 端扩展，运行在本地 VS Code UI host。它负责调用 Windows `FlashWindowEx`，让匹配的 VS Code 窗口闪烁。
- `qqqasdwx.vscode-window-flash-notify-relay`：workspace 端扩展，运行在当前 workspace 所在机器。它监听 `127.0.0.1`，接收本机脚本发来的 HTTP 请求，再通过 VS Code 命令转发给 UI 端扩展。

拆成两个扩展是为了适配 VS Code Remote 的 extension host 模型：远端 workspace 扩展能监听远端 localhost，本地 UI 扩展能调用 Windows 桌面 API。

## 安装

安装两个扩展：

```text
qqqasdwx.vscode-window-flash-notify
qqqasdwx.vscode-window-flash-notify-relay
```

在 Remote SSH、WSL、Dev Container、Vagrant 场景中：

- UI 端扩展安装在本地 VS Code。
- Relay 扩展安装在远端/workspace 侧。

纯本地场景也可以两个都装在本地。

## 快速测试

Relay 启动后会向 VS Code 集成终端注入环境变量：

```bash
WINDOW_FLASH_NOTIFY_ENDPOINT=http://127.0.0.1:7531/notify
```

如果当前终端里没有这个变量，请新开一个 VS Code 终端。

在 workspace 终端执行：

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}" \
  -H 'Content-Type: application/json' \
  --data '{"message":"Task finished","type":"info","action":"flash"}'
```

健康检查：

```bash
curl -fsS http://127.0.0.1:7531/health
```

## 通用 Hook 示例

下面的示例可以放进任意 shell hook、构建脚本或测试脚本的结束阶段：

```bash
#!/usr/bin/env bash
set -u

cwd="${PWD:-unknown}"
project="$(basename "$cwd")"
endpoint="${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}"

curl -fsS --max-time 3 -X POST "$endpoint" \
  -H 'Content-Type: application/json' \
  --data "{\"message\":\"Finished: ${project}\",\"type\":\"info\",\"action\":\"flash\",\"workspaceName\":\"${project}\",\"workspacePath\":\"${cwd}\"}" \
  >/dev/null || true
```

## 请求体

```json
{
  "message": "Task finished",
  "type": "info",
  "action": "flash",
  "workspaceName": "my-project",
  "workspacePath": "/path/to/my-project"
}
```

字段：

- `message`：日志文本，也可用于 VS Code 内部通知。
- `type`：`info`、`warning` 或 `error`。
- `action`：`flash`、`focus` 或 `none`，默认 `flash`。
- `workspaceName`：可选窗口标题匹配提示，默认当前 workspace 名称。
- `workspacePath`：可选 workspace 路径提示，basename 也会用于匹配窗口标题。
- `workspaceHints`：可选额外窗口标题匹配字符串数组。
- `showInternalNotification`：可选，控制 UI 端是否显示 VS Code 内部通知。

## 设置项

UI 端：

- `windowFlashNotify.flashUntilForeground`：持续闪烁任务栏图标，直到 VS Code 窗口回到前台。默认 `true`。
- `windowFlashNotify.flashCount`：关闭持续闪烁时请求的闪烁次数。默认 `8`。
- `windowFlashNotify.showInternalNotification`：收到 relay 请求后，同时显示 VS Code 内部通知。默认 `false`。

Relay 端：

- `windowFlashNotifyRelay.basePort`：启动 workspace 通知 HTTP server 时首先尝试的端口。默认 `7531`。
- `windowFlashNotifyRelay.portSearchRange`：从起始端口开始尝试的端口数量。默认 `10`。
- `windowFlashNotifyRelay.listenHost`：workspace HTTP server 的绑定地址。默认 `127.0.0.1`。
- `windowFlashNotifyRelay.authToken`：可选鉴权 token。

## 本地化

扩展 manifest 使用 VS Code 标准的 `package.nls.json` / `package.nls.zh-cn.json` 本地化方式。英文作为默认 fallback，中文用户会看到中文设置项和命令标题。

README 默认中文，英文文档见 [README.en.md](README.en.md)。

## 注意事项

- UI 端闪烁功能依赖 Windows 任务栏 API。非 Windows 本地桌面可以正常使用 relay endpoint，但 `flash` 不会产生窗口闪烁。
- `WINDOW_FLASH_NOTIFY_ENDPOINT` 只会注入到 VS Code 集成终端。已有终端如果没有该变量，请新开终端。
- 窗口匹配是保守的。如果没有任何可见 VS Code 窗口标题匹配 workspace hints，UI 端会返回错误，不会退回到“闪烁所有 VS Code 窗口”。
- `focus` 会主动把匹配窗口拉到前台；默认推荐使用 `flash`，避免打断当前焦点。
