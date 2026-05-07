# Window Flash Notify Relay

Window Flash Notify 的 workspace 端 relay。

它运行在当前 VS Code workspace 所在机器，监听 `127.0.0.1`，接收 `POST /notify`，然后转发给本地 UI 扩展命令 `windowFlashNotify.notify`。

适合 Remote SSH、WSL、Dev Container、Vagrant 或本地 workspace 中需要从终端 hook 发送通知的场景。

## English

Workspace-side relay for Window Flash Notify.

It listens on `127.0.0.1` inside the current VS Code workspace machine, accepts
`POST /notify`, and forwards the payload to the local UI extension command
`windowFlashNotify.notify`.

Install this extension in Remote SSH, WSL, Dev Container, Vagrant, or local
workspaces where terminal hooks need a localhost endpoint.
