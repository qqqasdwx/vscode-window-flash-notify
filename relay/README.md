# Window Flash Notify Relay

中文 | [English](README.en.md)

Window Flash Notify Relay 是 workspace 端扩展。它运行在当前 VS Code workspace 所在机器，监听 `127.0.0.1`，接收脚本发送的 `POST /notify`，再转发给本地 UI 端扩展。

通常需要和 UI 端扩展一起安装：

```text
qqqasdwx.vscode-window-flash-notify
qqqasdwx.vscode-window-flash-notify-relay
```

适合 Remote SSH、WSL、Dev Container、Vagrant 或本地 workspace 中需要从脚本发送完成提醒的场景。

## 快速测试

Relay 会向 VS Code 集成终端注入 `WINDOW_FLASH_NOTIFY_ENDPOINT`。如果当前终端里没有这个变量，请新开一个 VS Code 终端。

```bash
curl -fsS -X POST "${WINDOW_FLASH_NOTIFY_ENDPOINT:-http://127.0.0.1:7531/notify}" \
  -H 'Content-Type: application/json' \
  --data '{"message":"Task finished","type":"info","action":"flash"}'
```
