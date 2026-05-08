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

## 注意事项

- UI 端闪烁功能依赖 Windows 任务栏 API。非 Windows 本地桌面可以正常使用 relay endpoint，但 `flash` 不会产生窗口闪烁。
- `WINDOW_FLASH_NOTIFY_ENDPOINT` 只会注入到 VS Code 集成终端。已有终端如果没有该变量，请新开终端。
- Windows 窗口定位会优先使用当前 UI extension host 到 VS Code 窗口进程的进程链匹配；如果进程链无法唯一定位，才会回退到 workspace hints。
- 回退匹配仍然是保守的。如果没有任何可见 VS Code 窗口标题匹配 workspace hints，UI 端不会退回到“闪烁所有 VS Code 窗口”。需要排查时可运行命令 `Window Flash Notify: 诊断 Windows 窗口定位`。
- `focus` 会主动把匹配窗口拉到前台；默认推荐使用 `flash`，避免打断当前焦点。
- Toast 点击通过 VS Code URI 回到扩展，再尝试聚焦原始 VS Code 窗口。VS Code URI 可能先进入当前最上层窗口，因此扩展会在 URI 中带上原始 extension host 进程信息用于回跳定位。

## 安装

推荐先安装 UI 端扩展。UI 端扩展 manifest 已声明 relay 为 extension pack 成员，正常从 Marketplace 安装时会一并安装 relay：

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

最小调用只需要发送一个空的 `POST` 请求：

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}"
```

如果想自定义日志文本，可以发送 JSON 请求体：

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
  --data "{\"message\":\"Finished: ${project}\"}" \
  >/dev/null || true
```

## 请求体

请求体可以省略。省略时等价于 `{}`，默认会执行 `flash`。

可选 JSON 示例：

```json
{
  "message": "Task finished"
}
```

字段：

| 字段 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `title` | 否 | `"<workspace> - Window Flash Notify"` | Toast 通知标题。 |
| `message` | 否 | `"Notification received"` | 日志文本，也可用于 VS Code 内部通知。 |
| `type` | 否 | `"info"` | 消息级别。见下方 `type` 枚举。 |
| `action` | 否 | `"flash"` | 收到请求后的动作。见下方 `action` 枚举。 |
| `workspaceName` | 否 | 当前 VS Code workspace 名称 | 窗口标题匹配提示。通常不需要调用方传入，relay 会自动补齐。 |
| `workspacePath` | 否 | 当前 workspace 第一个 folder 路径 | workspace 路径匹配提示，basename 也会用于匹配窗口标题。通常不需要调用方传入。 |
| `workspaceHints` | 否 | 自动根据当前 workspace 生成 | 额外窗口标题匹配字符串数组。只有需要覆盖默认匹配行为时才传。 |
| `showInternalNotification` | 否 | UI 端设置 `windowFlashNotify.showInternalNotification` | 是否同时显示 VS Code 内部通知。 |
| `sound` | 否 | UI 端设置 `windowFlashNotify.soundEnabled` | 是否播放 Windows 系统提示音。 |
| `showToast` | 否 | UI 端设置 `windowFlashNotify.showToast` | 是否显示 Windows toast 通知。 |
| `toastTimeout` | 否 | UI 端设置 `windowFlashNotify.toastTimeout` | Toast 通知过期时间，单位为秒。 |

`type` 枚举：

| 值 | 含义 |
| --- | --- |
| `info` | 普通信息。用于成功、完成、一般提醒。 |
| `warning` | 警告信息。用于需要注意但不一定失败的情况。 |
| `error` | 错误信息。用于失败或需要立即处理的情况。 |

`action` 枚举：

| 值 | 含义 |
| --- | --- |
| `flash` | 闪烁匹配的 VS Code 窗口任务栏图标，不抢焦点。推荐默认值。 |
| `focus` | 将匹配的 VS Code 窗口拉到前台，会打断当前焦点。 |
| `none` | 不执行窗口动作，只保留日志/可选内部通知。 |

## 设置项

UI 端：

- `windowFlashNotify.flashUntilForeground`：持续闪烁任务栏图标，直到 VS Code 窗口回到前台。默认 `true`。
- `windowFlashNotify.flashCount`：关闭持续闪烁时请求的闪烁次数。默认 `8`。
- `windowFlashNotify.showInternalNotification`：收到 relay 请求后，同时显示 VS Code 内部通知。默认 `false`。
- `windowFlashNotify.soundEnabled`：收到通知请求后播放 Windows 系统提示音。默认 `false`。
- `windowFlashNotify.showToast`：收到通知请求后显示 Windows toast 通知。默认 `false`。
- `windowFlashNotify.toastTimeout`：Windows toast 通知过期时间，单位为秒。默认 `15`。

UI 端命令：

- `Window Flash Notify: 测试 UI 闪烁`：发送一次测试闪烁。
- `Window Flash Notify: 诊断 Windows 窗口定位`：在输出面板打印可见 VS Code 窗口、进程链、匹配结果和 fallback 原因。

Relay 端：

- `windowFlashNotifyRelay.basePort`：启动 workspace 通知 HTTP server 时首先尝试的端口。默认 `7531`。
- `windowFlashNotifyRelay.portSearchRange`：从起始端口开始尝试的端口数量。默认 `10`。
- `windowFlashNotifyRelay.listenHost`：workspace HTTP server 的绑定地址。默认 `127.0.0.1`。
- `windowFlashNotifyRelay.authToken`：可选鉴权 token。

## 本地化

扩展 manifest 使用 VS Code 标准的 `package.nls.json` / `package.nls.zh-cn.json` 本地化方式。英文作为默认 fallback，中文用户会看到中文设置项和命令标题。

README 默认中文，英文文档见 [README.en.md](README.en.md)。
