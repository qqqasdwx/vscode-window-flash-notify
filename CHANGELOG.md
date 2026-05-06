# Change Log

## 0.0.1

- Initial preview release.
- Starts a local HTTP server from the VS Code UI extension host.
- Flashes the matching VS Code taskbar window on Windows without stealing focus.
- Writes `.vscode/window-flash-notify-port.json` for scripts running in terminals, SSH sessions, or VMs.

## 0.0.2

- Fix Windows PowerShell process id variable conflict.

## 0.0.3

- Add optional native desktop notification support.
- Clicking the native notification attempts to focus the matching VS Code window.

## 0.0.4

- Handle additional Windows toast click/action responses.
- Register a VS Code URI handler for future protocol-based focusing.

## 0.0.5

- Replace callback-based Toast handling with protocol-activated Windows Toasts.
- Toast clicks open the extension URI handler, then focus the matching VS Code window.

## 0.0.6

- Use a persistent PowerShell Toast listener for click-to-focus on Windows.
- Toast clicks now run the same focus routine already used by the HTTP `focus` action.
