# Change Log

## 0.2.26

- Add custom WAV notification sounds for the UI extension.
- Add commands to select, clear, and test the configured notification sound.
- Play the configured custom sound when notification sound is enabled, falling
  back to the Windows system sound if the custom file is unavailable.

## 0.2.25

- Add runtime localization bundles for UI and relay extension messages.
- Localize relay install prompts, reload prompts, toast action text, test
  notification messages, copied-command confirmation, and terminal environment
  descriptions.

## 0.2.24

- Speed up toast click focus by taking a title-only strong workspace hint fast
  path when it uniquely identifies the same target the full matcher would pick.
- Stop focus retries as soon as the target VS Code window becomes foreground.

## 0.2.23

- Use `GetWindowPlacement` when focusing windows so maximized windows restored
  from the background keep their maximized placement more reliably.

## 0.2.22

- Preserve maximized VS Code windows when focusing them from toast clicks or
  explicit focus requests.

## 0.2.21

- Allow `windowFlashNotify.toastTimeout` and request `toastTimeout` to be `0`,
  which leaves the Windows toast expiration unset.

## 0.2.20

- Launch the `windowflashnotify://` protocol helper through `wscript.exe` so
  toast clicks do not open a console window.
- Fix the protocol helper PowerShell entrypoint so the clicked URI is parsed
  as the script argument.

## 0.2.19

- Route Windows toast clicks through a local `windowflashnotify://` protocol
  helper so VS Code no longer first focuses the last active window.

## 0.2.18

- Prevent toast click focus URIs from mixing in the workspace hints of whichever
  VS Code window receives the URI first.

## 0.2.17

- Prompt from the UI extension to install or update the workspace-side Relay
  extension when a remote window is missing it.
- Remove temporary UI debug log endpoints and PowerShell diagnostic log files
  from the publish build.
- Exclude repository agent instructions from the packaged UI VSIX.

## 0.2.16

- Prefer exact remote workspace title hints, such as `[SSH: host]`, over generic
  process-chain matches when selecting the target VS Code window.
- Log selected window titles and match scores for flash/focus diagnostics.

## 0.2.15

- Disable VS Code internal notifications for relay requests.
- Remove the `windowFlashNotify.showInternalNotification` setting from the UI
  extension manifest and documentation.

## 0.2.14

- Prefer the registered VS Code Start Menu AppID for Windows toast
  notifications, such as `Microsoft.VisualStudioCode`, instead of the display
  name.

## 0.2.13

- Run temporary PowerShell diagnostics as non-detached fire-and-forget child
  processes so stdout, stderr, exit code, and watchdog timeouts are captured.
- Use `-Command` for the diagnostic bootstrap to expose command-line parsing
  errors in UI logs.

## 0.2.12

- Launch detached PowerShell actions through a minimal encoded bootstrap that
  logs before invoking the generated script file.

## 0.2.11

- Log detached PowerShell child process pid, error, exit, and log-file checks.
- Launch detached actions through the full Windows PowerShell executable path.

## 0.2.10

- Add temporary UI log diagnostics through relay `/debug/ui-log`.
- Write detached PowerShell action logs under `%TEMP%\\vscode-window-flash-notify`.
- Launch detached PowerShell actions hidden without a transient `cmd.exe` window.

## 0.2.9

- Remove the remaining notify fallback `version` field.
- Keep notify URI fallback fire-and-return; URI acknowledgements are used only
  for `/health` UI version probing.

## 0.2.8

- Move UI version reporting out of notify results and into `/health`.
- Add a dedicated UI health command and URI health acknowledgement path so relay
  health checks can report the local UI extension version.
- Strip `version` from notify results returned by older UI extensions.

## 0.2.7

- Add one-shot relay acknowledgements for URI fallback dispatch so the relay can
  return the actual UI extension result, including the UI version.

## 0.2.6

- Add a UI `/notify` URI handler for relay fallback dispatch.
- Add a relay-side UI command timeout so HTTP requests no longer hang forever
  when the local UI extension host stops returning command results.
- Dispatch notification requests through the VS Code URI handler after UI
  command timeout, with an explicit fallback marker in the response.

## 0.2.5

- Delay normal Windows actions until after notify command results are returned.
- Launch detached PowerShell actions through temporary `.ps1` files and
  `cmd start /b` to avoid tying the UI extension host to action execution.
- Include a notify implementation marker in UI command results.

## 0.2.4

- Use detached fire-and-forget PowerShell processes for normal flash, focus,
  sound, and toast actions so notify command results are never tied to Windows
  action completion.

## 0.2.3

- Read extension versions from the installed package files for `/health`,
  avoiding stale VS Code extension scan metadata after local VSIX installs.

## 0.2.2

- Return relay and discovered UI extension versions from `/health`.
- Include the UI extension version in notify command results.

## 0.2.1

- Run Windows flash, focus, and sound actions in the background so relay HTTP
  requests return even if a Windows PowerShell action hangs.
- Force-kill timed out PowerShell process trees on Windows.

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
