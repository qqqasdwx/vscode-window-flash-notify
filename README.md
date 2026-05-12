# Window Flash Notify

中文 | [English](README.en.md)

Window Flash Notify 让脚本、终端任务、远端构建和测试流程在结束时提醒你：它会闪烁匹配的 Windows VS Code 任务栏按钮，默认不抢占当前焦点。

适用场景：

- Remote SSH、WSL、Dev Containers、Vagrant 等远端工作区中的长任务提醒
- 本地或远端 shell hook、构建脚本、测试脚本
- 多个 VS Code 窗口同时打开时，只提醒任务所在窗口
- 需要可选声音提示或 Windows toast 通知的自动化流程

## 功能特性

- 闪烁匹配的 VS Code 窗口任务栏按钮，默认不打断当前工作。
- 可选标题提醒：`flash` 通知会在未聚焦的关联 VS Code 窗口标题中闪烁固定槽位的移动 `!` 标记。
- 支持 `flash`、`focus`、`none` 三种动作。
- 支持 Windows 系统提示音、自定义 WAV 通知声音和原生 toast 通知。
- 点击 toast 后会尝试回到发出通知的 VS Code 窗口；关联窗口重新获得焦点时可自动清理本扩展创建的 toast。
- 支持通过 `${windowFlashNotifyId}` 窗口标题变量进行精准单窗口匹配。
- 支持 VS Code Remote 场景，由 workspace 侧 relay 接收脚本请求，再转发到本地 UI 侧扩展。
- relay 会向 VS Code 集成终端注入 `WINDOW_FLASH_NOTIFY_ENDPOINT`，脚本可以直接调用。
- relay 会把 workspace、remote 标识和当前编辑器信息转换为 UI 端可用于标题匹配的提示。
- `/health` 接口会返回 relay 和 UI 扩展版本，便于诊断安装状态。
- 支持中英文 manifest 与运行时提示本地化。

## 安装

本项目包含两个扩展：

- `qqqasdwx.vscode-window-flash-notify`：UI 端扩展，安装在本地 VS Code。
- `qqqasdwx.vscode-window-flash-notify-relay`：workspace 端 relay，安装在脚本实际运行的本地或远端工作区。

推荐先安装 UI 端扩展。UI 端扩展包含 relay 的 extension pack 声明；在远端窗口中，如果 relay 未安装或版本过旧，UI 端扩展会提示安装或更新。安装或更新 relay 后，需要 Reload Window 才能让 relay 激活并注入终端环境变量。

纯本地使用时，两个扩展都可以安装在本地。Remote SSH、WSL、Dev Containers、Vagrant 等场景中，UI 端扩展在本地运行，relay 在远端/workspace 侧运行。

首次使用精准窗口匹配时，UI 端会提示将 `${windowFlashNotifyId}` 和 `${windowFlashNotifyAlert}` 加入本地 `window.title`。启用后，每个 relay 窗口会在标题中显示一个短 ID，例如 `[WFN:3A7F]`，通知会优先用这个 ID 精确定位窗口。`flash` 通知还可以在标题前方显示固定槽位的移动 `!` 标题提醒，避免标题在闪烁过程中反复变长变短。也可以手动运行命令 `Window Flash Notify: 启用精准窗口匹配`。

## 快速开始

relay 启动后会向 VS Code 集成终端注入环境变量：

```bash
WINDOW_FLASH_NOTIFY_ENDPOINT=http://127.0.0.1:7531/notify
```

如果当前终端没有该变量，请打开一个新的 VS Code 集成终端。端口被占用时 relay 会尝试后续端口，因此脚本应优先使用环境变量，而不是固定写死 `7531`。

发送一个空的 `POST` 请求即可触发默认闪烁：

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}"
```

发送 JSON 请求体可以自定义提示内容和行为：

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}" \
  -H 'Content-Type: application/json' \
  --data '{"message":"Task finished","type":"info","action":"flash"}'
```

查看 relay、UI 扩展版本和当前 endpoint：

```bash
endpoint="${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}"
curl -fsS "${endpoint%/notify}/health"
```

## 脚本示例

下面的示例适合放在构建、测试或部署脚本的结束阶段：

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

带声音和 Windows toast 的示例：

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}" \
  -H 'Content-Type: application/json' \
  --data '{"message":"Build finished","type":"info","action":"flash","sound":true,"showToast":true,"toastTimeout":0}'
```

`toastTimeout: 0` 表示不设置 toast 过期时间，由 Windows 使用默认行为。

自定义通知声音需要在本地 Windows UI 端配置。运行命令 `Window Flash Notify: 选择通知声音`，选择一个 `.wav` 文件后，扩展会复制到自己的存储目录。之后请求中传 `sound: true`，或开启 `windowFlashNotify.soundEnabled`，都会优先播放该自定义声音；如果文件不可用，会回退到 Windows 系统提示音。

## 请求接口

`POST /notify` 的请求体可以省略。省略时等价于 `{}`，默认执行 `flash`。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `title` | `string` | `"<workspace> - Window Flash Notify"` | Windows toast 标题。 |
| `message` | `string` | `"Notification received"` | 通知正文。 |
| `type` | `"info" \| "warning" \| "error"` | `"info"` | 消息级别。未配置自定义声音时，会选择对应的 Windows 系统提示音。 |
| `action` | `"flash" \| "focus" \| "none"` | `"flash"` | 收到请求后的窗口动作。 |
| `workspaceName` | `string` | 当前 VS Code workspace 名称 | 窗口匹配提示。通常不需要手动传入，relay 会自动补齐。 |
| `workspacePath` | `string` | 当前 workspace 第一个 folder 路径 | 窗口匹配提示。通常不需要手动传入，relay 会自动补齐。 |
| `workspaceHints` | `string[]` | 根据当前 workspace 自动生成 | 额外窗口匹配提示。仅在需要覆盖默认匹配行为时使用。 |
| `sound` | `boolean` | `windowFlashNotify.soundEnabled` | 是否播放 Windows 通知声音。配置自定义 WAV 后优先播放自定义声音。 |
| `showToast` | `boolean` | `windowFlashNotify.showToast` | 是否显示 Windows toast 通知。 |
| `toastTimeout` | `number` | `windowFlashNotify.toastTimeout` | Toast 过期时间，单位为秒。设为 `0` 表示不设置过期时间。 |

`action` 可选值：

| 值 | 行为 |
| --- | --- |
| `flash` | 闪烁匹配窗口的任务栏按钮，不抢占焦点。推荐默认值。 |
| `focus` | 将匹配窗口带到前台，会改变当前焦点。 |
| `none` | 不执行窗口动作，只保留可选声音和 toast 行为。 |

如果设置了 relay 鉴权 token，请在请求中加入 header 或 query 参数：

```bash
curl -fsS -X POST "$WINDOW_FLASH_NOTIFY_ENDPOINT" \
  -H 'Content-Type: application/json' \
  -H 'X-Window-Flash-Token: your-token' \
  --data '{"message":"Task finished"}'
```

## 设置项

UI 端扩展：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `windowFlashNotify.flashUntilForeground` | `true` | 持续闪烁任务栏按钮，直到 VS Code 窗口回到前台。 |
| `windowFlashNotify.flashCount` | `8` | 关闭持续闪烁时请求的闪烁次数。 |
| `windowFlashNotify.soundEnabled` | `false` | 收到请求后默认播放 Windows 通知声音。 |
| `windowFlashNotify.customSoundPath` | `""` | 可选本地 `.wav` 文件路径。建议通过“选择通知声音”命令设置。 |
| `windowFlashNotify.showToast` | `false` | 收到请求后默认显示 Windows toast 通知。 |
| `windowFlashNotify.toastTimeout` | `15` | Toast 过期时间，单位为秒；设为 `0` 表示不设置过期时间。 |
| `windowFlashNotify.titleAlertEnabled` | `true` | 当关联 VS Code 窗口未获得焦点时，对 `flash` 通知同时闪烁窗口标题提醒；需要 `window.title` 包含 `${windowFlashNotifyAlert}`。 |
| `windowFlashNotify.titleAlertDuration` | `10` | 关闭 `windowFlashNotify.flashUntilForeground` 时，标题提醒闪烁持续时间，单位为秒。 |
| `windowFlashNotify.clearToastOnFocus` | `true` | 关联 VS Code 窗口重新获得焦点时，自动清理本扩展创建的 toast 通知。 |
| `windowFlashNotify.autoInstallRelay` | `true` | 在远端窗口中检测 relay，缺失或过旧时提示安装/更新。 |
| `windowFlashNotify.useProcessChainTieBreaker` | `false` | 仅当多个窗口命中同分标题提示时，使用 Windows 进程链作为辅助决胜。默认关闭；多数窗口共享同一个 VS Code 主进程时帮助有限，并会增加 WMI/CIM 查询开销。 |
| `windowFlashNotify.promptWindowTitleId` | `true` | 当本地 `window.title` 缺少 `${windowFlashNotifyId}` 时，提示启用精准窗口匹配。 |

Relay 扩展：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `windowFlashNotifyRelay.basePort` | `7531` | relay HTTP 服务首先尝试监听的端口。 |
| `windowFlashNotifyRelay.portSearchRange` | `10` | 从起始端口开始尝试的端口数量。 |
| `windowFlashNotifyRelay.listenHost` | `127.0.0.1` | relay HTTP 服务绑定地址。 |
| `windowFlashNotifyRelay.authToken` | `""` | 可选鉴权 token；设置后请求必须带 `X-Window-Flash-Token` header 或 `token` query 参数。 |

## 命令

UI 端扩展：

- `Window Flash Notify: 测试 UI 闪烁`：发送一次 UI 端测试闪烁。
- `Window Flash Notify: 诊断 Windows 窗口定位`：在输出面板中打印可见 VS Code 窗口、标题提示匹配结果，以及启用时的进程链辅助信息。
- `Window Flash Notify: 在远程窗口安装 Relay`：手动检查并安装/更新当前远端窗口中的 relay。
- `Window Flash Notify: 启用精准窗口匹配`：将 `${windowFlashNotifyId}` 加入本地 `window.title`，用于按 relay 窗口 ID 精确匹配。
- `Window Flash Notify: 选择通知声音`：选择本地 `.wav` 文件并复制到扩展存储中。
- `Window Flash Notify: 清除通知声音`：清除当前自定义通知声音配置。
- `Window Flash Notify: 测试通知声音`：播放一次当前配置的通知声音。

Relay 扩展：

- `Window Flash Notify Relay: 复制 Curl 命令`：复制当前工作区可用的 curl 示例命令。
- `Window Flash Notify Relay: 测试闪烁`：从 relay 侧发送一次测试通知。

## 平台与限制

- 窗口闪烁、聚焦、声音和 toast 功能依赖本地 Windows 桌面环境。
- 非 Windows 本地桌面可以运行 relay endpoint，但不会产生 Windows 任务栏闪烁。
- `focus` 会主动改变前台窗口；不希望打断当前工作时请使用默认的 `flash`。
- 窗口定位优先使用 relay 生成的 `[WFN:xxxx]` 标题 ID。该 ID 需要本地 `window.title` 包含 `${windowFlashNotifyId}`，标题提醒需要包含 `${windowFlashNotifyAlert}`；可通过命令 `Window Flash Notify: 启用精准窗口匹配` 自动写入本地用户设置。
- 如果标题 ID 不可用，窗口定位会回退到 relay 生成的标题匹配提示，常见来源包括 workspace 名称/路径、Remote SSH/WSL 等 remote 标识、workspace 文件、当前或可见编辑器路径。
- 只有标题提示能唯一定位窗口时，扩展才会执行闪烁或聚焦；如果多个窗口无法可靠区分，扩展会避免无差别闪烁所有 VS Code 窗口。
- 进程链匹配默认关闭，只在多个窗口命中同分标题提示时可作为辅助决胜。它适合从不同 VS Code 主进程打开窗口的少数场景；如果多个窗口都汇聚到同一个主进程，通常不会提高准确率，并会增加 WMI/CIM 查询开销。
- 点击 toast 后会尝试返回原始 VS Code 窗口；Windows 启动协议处理程序可能需要短暂时间。
- 自动清理 toast 依赖 Windows 通知历史 API；它会按本扩展设置的 tag/group 删除通知历史中的对应 toast，正在显示的横幅通常也会随之消失，但最终表现由 Windows 通知系统决定。

## 排障

- 终端里没有 `WINDOW_FLASH_NOTIFY_ENDPOINT`：确认 relay 已安装并启用，然后打开新的 VS Code 集成终端。
- `/health` 不可访问：检查 relay 是否安装在当前 workspace/remote 侧，并确认窗口已 Reload。
- 没有闪烁：确认本地 VS Code 运行在 Windows 桌面环境，且请求的 `action` 是 `flash`。
- 提醒到了错误窗口：运行 `Window Flash Notify: 诊断 Windows 窗口定位`，查看输出面板中的窗口匹配结果；尽量避免同时打开多个标题完全相同的 VS Code 窗口。
- toast 不显示：确认 Windows 通知未被系统策略、专注助手或 VS Code 通知设置屏蔽。

## 安全

relay 默认只监听 `127.0.0.1`，用于同一台 workspace 机器上的脚本调用。除非明确需要，请不要把 `windowFlashNotifyRelay.listenHost` 暴露到外部网络。如果必须暴露，请设置 `windowFlashNotifyRelay.authToken` 并限制网络访问来源。

## 许可

MIT
