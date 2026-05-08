# Change Log

## 0.2.0

- Add Marketplace icons for the UI and relay extensions.
- Prefer Windows process-chain window targeting, with workspace hints as a fallback.
- Add a Windows targeting diagnostics command.
- Add optional Windows system sound and toast notifications.
- Open toast clicks through the VS Code URI handler and retarget the original window.
- Declare the relay as an extension pack member of the UI extension to reduce missed installs.

## 0.1.7

- Verify the publish workflow with Node 24 action runtime versions.

## 0.1.6

- Document current workspace-title based window targeting limitations.
- Add a TODO for future VS Code/Electron process-chain based window targeting.
- Add repository contributor guidelines.

## 0.1.5

- Document the true minimum notification call: an empty `POST` request.
- Simplify examples further so `message` is the only shown JSON field.

## 0.1.4

- Document notification request fields in tables, including required status,
  defaults, and enum values.
- Simplify hook examples to rely on relay-provided workspace metadata.

## 0.1.3

- Remove the relay extension's hard dependency on the UI extension so it can
  activate in the workspace extension host while the UI extension runs in the
  local UI extension host.

## 0.1.2

- Replace inline bilingual manifest strings with VS Code `package.nls` localization files.
- Split README content into Chinese default docs and separate English docs.
- Generalize examples from a tool-specific hook to a generic shell hook.
- Stop writing workspace port files; the relay now injects `WINDOW_FLASH_NOTIFY_ENDPOINT` into VS Code terminals.

## 0.1.1

- Make the main README Chinese-first with English reference content.
- Add bilingual descriptions for UI and relay extension settings.
- Add bilingual relay README content for the relay Marketplace page.

## 0.1.0

- Switch to the two-extension relay architecture.
- The UI extension now only registers local commands and calls Windows
  `FlashWindowEx`; it no longer starts an HTTP server.
- Add `qqqasdwx.vscode-window-flash-notify-relay`, a workspace extension that
  listens on `127.0.0.1` and forwards notifications to the UI extension.
- Update hook examples to use `http://127.0.0.1:<port>/notify` from the
  workspace machine.

## 0.0.7

- Stop falling back to every visible VS Code window when title matching fails.
- Add workspace title hints to improve matching for Remote SSH titles such as
  `project [SSH: host]`.
- Write `workspaceHints` to the port file and health response for easier
  debugging.

## 0.0.1

- Initial preview release.
- Starts a local HTTP server from the VS Code UI extension host.
- Flashes the matching VS Code taskbar window on Windows without stealing focus.
- Writes endpoint metadata for scripts running in terminals, SSH sessions, or VMs.

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
