# Window Flash Notify Relay

Workspace-side relay for Window Flash Notify.

It listens on `127.0.0.1` inside the current VS Code workspace machine, accepts
`POST /notify`, and forwards the payload to the local UI extension command
`windowFlashNotify.notify`.

Install this extension in Remote SSH, WSL, Dev Container, Vagrant, or local
workspaces where terminal hooks need a localhost endpoint.
