# Window Flash Notify Relay

中文 | [English](README.en.md)

Window Flash Notify Relay 是 workspace 端扩展。它运行在当前 VS Code workspace 所在机器，监听 `127.0.0.1`，接收脚本发送的 `POST /notify`，再转发给本地 UI 端扩展。

通常需要和 UI 端扩展一起安装。推荐先安装 UI 端扩展，它会声明 relay 为 extension pack 成员：

```text
qqqasdwx.vscode-window-flash-notify
qqqasdwx.vscode-window-flash-notify-relay
```

适合 Remote SSH、WSL、Dev Container、Vagrant 或本地 workspace 中需要从脚本发送完成提醒的场景。

relay 会自动为当前窗口生成短 ID，并通过 `${windowFlashNotifyId}` 标题变量参与窗口匹配。启用 UI 端的精准窗口匹配后，VS Code 标题中会出现类似 `[WFN:3A7F]` 的标识，UI 端会优先用这个标识只闪烁发出通知的窗口。relay 也会把当前 workspace、remote 标识和编辑器上下文转换成备用标题匹配提示。

## 快速测试

Relay 会向 VS Code 集成终端注入 `WINDOW_FLASH_NOTIFY_ENDPOINT`。如果当前终端里没有这个变量，请新开一个 VS Code 终端。

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}"
```

发送 toast 和声音提示：

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}" \
  -H 'Content-Type: application/json' \
  --data '{"message":"Task finished","showToast":true,"sound":true}'
```
