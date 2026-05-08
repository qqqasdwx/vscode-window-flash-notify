import { spawn } from "node:child_process";
import { basename } from "node:path";
import * as vscode from "vscode";

type NotifyType = "info" | "warning" | "error";
type NotifyAction = "flash" | "focus" | "none";

interface NotifyPayload {
  title?: string;
  message?: string;
  type?: NotifyType;
  action?: NotifyAction;
  workspaceName?: string;
  workspacePath?: string;
  workspaceHints?: string[];
  showInternalNotification?: boolean;
  sound?: boolean;
  showToast?: boolean;
  toastTimeout?: number;
}

interface NotifyResult {
  success: true;
  action: NotifyAction;
  workspaceName: string;
  workspaceHints: string[];
  platform: NodeJS.Platform;
}

const defaultExtensionId = "qqqasdwx.vscode-window-flash-notify";
const output = vscode.window.createOutputChannel("Window Flash Notify");

let extensionId = defaultExtensionId;

export function activate(context: vscode.ExtensionContext): void {
  extensionId = context.extension.id || defaultExtensionId;
  output.appendLine("Activating Window Flash Notify UI");

  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        await handleExtensionUri(uri);
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("windowFlashNotify.notify", async (payload?: NotifyPayload) => {
      return handleNotification(payload || {});
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("windowFlashNotify.flashWindow", async (payload?: NotifyPayload) => {
      return handleNotification({ ...(payload || {}), action: "flash" });
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("windowFlashNotify.focusWindow", async (payload?: NotifyPayload) => {
      return handleNotification({ ...(payload || {}), action: "focus" });
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("windowFlashNotify.testFlash", async () => {
      await handleNotification({
        message: "Test notification",
        type: "info",
        action: "flash"
      });
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("windowFlashNotify.diagnoseWindows", async () => {
      await diagnoseWindowsTargeting();
    })
  );
}

export function deactivate(): void {
  output.appendLine("Deactivating Window Flash Notify UI");
}

async function handleExtensionUri(uri: vscode.Uri): Promise<void> {
  output.appendLine(`URI received: ${uri.toString(true)}`);
  if (uri.path !== "/focus") {
    return;
  }

  const params = new URLSearchParams(uri.query);
  const workspaceName = params.get("workspaceName") || undefined;
  const workspaceHints = getWorkspaceMatchHints(
    workspaceName,
    undefined,
    params.getAll("workspaceHint")
  );
  const targetProcessId = parsePositiveInteger(params.get("targetPid")) || process.pid;

  await runWindowsWindowAction("focus", workspaceHints, targetProcessId);
}

async function handleNotification(payload: NotifyPayload): Promise<NotifyResult> {
  const message = payload.message || "Notification received";
  const action = payload.action || "flash";
  const type = payload.type || "info";
  const workspaceHints = getWorkspaceMatchHints(
    payload.workspaceName,
    payload.workspacePath,
    payload.workspaceHints
  );
  const workspaceName = workspaceHints[0] || payload.workspaceName || getWorkspaceName();

  output.appendLine(
    `Notify: action=${action} type=${type} workspace=${workspaceName} hints=${workspaceHints.join("|")} message=${message}`
  );

  if (action === "flash") {
    await runWindowsWindowAction("flash", workspaceHints);
  } else if (action === "focus") {
    await runWindowsWindowAction("focus", workspaceHints);
  }

  if (payload.sound ?? getConfig().get<boolean>("soundEnabled", false)) {
    await playNotificationSound(type);
  }

  if (payload.showToast ?? getConfig().get<boolean>("showToast", false)) {
    await showToastNotification(payload, workspaceName, workspaceHints);
  }

  const showInternal =
    payload.showInternalNotification ?? getConfig().get<boolean>("showInternalNotification", false);

  if (showInternal) {
    await showInternalNotification(type, `[${workspaceName}] ${message}`, workspaceHints);
  }

  return {
    success: true,
    action,
    workspaceName,
    workspaceHints,
    platform: process.platform
  };
}

async function showInternalNotification(
  type: NotifyType,
  message: string,
  workspaceHints: string[]
): Promise<void> {
  const focus = "Focus";
  const flashAgain = "Flash Again";
  let selected: string | undefined;

  if (type === "error") {
    selected = await vscode.window.showErrorMessage(message, focus, flashAgain);
  } else if (type === "warning") {
    selected = await vscode.window.showWarningMessage(message, focus, flashAgain);
  } else {
    selected = await vscode.window.showInformationMessage(message, focus, flashAgain);
  }

  if (selected === focus) {
    await runWindowsWindowAction("focus", workspaceHints);
  } else if (selected === flashAgain) {
    await runWindowsWindowAction("flash", workspaceHints);
  }
}

async function playNotificationSound(type: NotifyType): Promise<void> {
  if (process.platform !== "win32") {
    output.appendLine(`Skipping sound; platform is ${process.platform}`);
    return;
  }

  try {
    await runPowerShell(getSoundPowerShell(), {
      ...process.env,
      WINDOW_FLASH_NOTIFY_TYPE: type
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Sound failed: ${message}`);
  }
}

async function showToastNotification(
  payload: NotifyPayload,
  workspaceName: string,
  workspaceHints: string[]
): Promise<void> {
  if (process.platform !== "win32") {
    output.appendLine(`Skipping native toast; platform is ${process.platform}`);
    return;
  }

  const message = payload.message || "Notification received";
  const title = payload.title || `${workspaceName} - Window Flash Notify`;
  const toastTimeout = clampNumber(
    payload.toastTimeout ?? getConfig().get<number>("toastTimeout", 15),
    1,
    300
  );
  const focusUri = buildFocusUri(workspaceName, workspaceHints, process.pid);

  output.appendLine(`Showing toast: ${title} - ${message}`);
  spawnPowerShellDetached(getToastPowerShell(), {
    ...process.env,
    WINDOW_FLASH_NOTIFY_TOAST_TITLE: title,
    WINDOW_FLASH_NOTIFY_TOAST_MESSAGE: message,
    WINDOW_FLASH_NOTIFY_TOAST_TIMEOUT: String(toastTimeout),
    WINDOW_FLASH_NOTIFY_TOAST_FOCUS_URI: focusUri,
    WINDOW_FLASH_NOTIFY_PRODUCT: vscode.env.appName || "Visual Studio Code"
  });
}

function buildFocusUri(
  workspaceName: string,
  workspaceHints: string[],
  targetProcessId: number
): string {
  const params = new URLSearchParams();
  params.set("targetPid", String(targetProcessId));
  params.set("workspaceName", workspaceName);
  for (const hint of workspaceHints) {
    params.append("workspaceHint", hint);
  }

  const uri = vscode.Uri.from({
    scheme: vscode.env.uriScheme,
    authority: extensionId,
    path: "/focus",
    query: params.toString()
  });
  return uri.toString(true);
}

async function diagnoseWindowsTargeting(): Promise<void> {
  output.show(true);
  output.appendLine("");
  output.appendLine("=== Window Flash Notify Windows Targeting Diagnostics ===");

  if (process.platform !== "win32") {
    output.appendLine(`Skipping diagnostics; platform is ${process.platform}`);
    return;
  }

  try {
    const diagnostics = await runPowerShellCapture(
      getWindowDiagnosticsPowerShell(),
      getWindowActionEnv("none", getWorkspaceMatchHints(), process.pid),
      10000
    );
    output.appendLine(diagnostics.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Diagnostics failed: ${message}`);
  }
}

async function runWindowsWindowAction(
  action: "flash" | "focus",
  workspaceHints: string[],
  targetProcessId = process.pid
): Promise<void> {
  if (process.platform !== "win32") {
    output.appendLine(`Skipping ${action}; platform is ${process.platform}`);
    return;
  }

  await runPowerShell(getWindowActionPowerShell(), getWindowActionEnv(action, workspaceHints, targetProcessId));
}

function getWindowActionEnv(
  action: NotifyAction,
  workspaceHints: string[],
  targetProcessId: number
): NodeJS.ProcessEnv {
  const config = getConfig();
  const flashUntilForeground = config.get<boolean>("flashUntilForeground", true);
  const flashCount = config.get<number>("flashCount", 8);

  return {
    ...process.env,
    WINDOW_FLASH_NOTIFY_ACTION: action,
    WINDOW_FLASH_NOTIFY_TARGET_PID: String(targetProcessId),
    WINDOW_FLASH_NOTIFY_WORKSPACE: workspaceHints[0] || "",
    WINDOW_FLASH_NOTIFY_WORKSPACE_HINTS: workspaceHints.join("\n"),
    WINDOW_FLASH_NOTIFY_PRODUCT: vscode.env.appName || "Visual Studio Code",
    WINDOW_FLASH_NOTIFY_UNTIL_FOREGROUND: flashUntilForeground ? "1" : "0",
    WINDOW_FLASH_NOTIFY_COUNT: String(flashCount)
  };
}

function getSoundPowerShell(): string {
  return `
$ErrorActionPreference = 'Stop'
$type = $env:WINDOW_FLASH_NOTIFY_TYPE

if ($type -eq 'error') {
  [System.Media.SystemSounds]::Hand.Play()
} elseif ($type -eq 'warning') {
  [System.Media.SystemSounds]::Exclamation.Play()
} else {
  [System.Media.SystemSounds]::Asterisk.Play()
}

Start-Sleep -Milliseconds 700
`;
}

function getToastPowerShell(): string {
  return `
$ErrorActionPreference = 'Stop'

$title = $env:WINDOW_FLASH_NOTIFY_TOAST_TITLE
$message = $env:WINDOW_FLASH_NOTIFY_TOAST_MESSAGE
$focusUri = $env:WINDOW_FLASH_NOTIFY_TOAST_FOCUS_URI
$appId = $env:WINDOW_FLASH_NOTIFY_PRODUCT
if ([string]::IsNullOrWhiteSpace($appId)) {
  $appId = 'Visual Studio Code'
}

$timeoutSeconds = 15
if ($env:WINDOW_FLASH_NOTIFY_TOAST_TIMEOUT) {
  [void][int]::TryParse($env:WINDOW_FLASH_NOTIFY_TOAST_TIMEOUT, [ref]$timeoutSeconds)
}
$timeoutSeconds = [Math]::Max(1, [Math]::Min(300, $timeoutSeconds))

function Escape-Xml([string]$value) {
  return [System.Security.SecurityElement]::Escape($value)
}

$escapedTitle = Escape-Xml $title
$escapedMessage = Escape-Xml $message
$escapedFocusUri = Escape-Xml $focusUri

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$xmlText = @"
<toast activationType="protocol" launch="$escapedFocusUri">
  <visual>
    <binding template="ToastGeneric">
      <text>$escapedTitle</text>
      <text>$escapedMessage</text>
    </binding>
  </visual>
  <actions>
    <action content="Focus VS Code" arguments="$escapedFocusUri" activationType="protocol" />
  </actions>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.ExpirationTime = [System.DateTimeOffset]::Now.AddSeconds($timeoutSeconds)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$notifier.Show($toast)
`;
}

function getWindowLookupPowerShell(): string {
  return `
$ErrorActionPreference = 'Stop'
$workspace = $env:WINDOW_FLASH_NOTIFY_WORKSPACE
$workspaceHintsRaw = $env:WINDOW_FLASH_NOTIFY_WORKSPACE_HINTS
$product = $env:WINDOW_FLASH_NOTIFY_PRODUCT
$targetProcessId = 0
if ($env:WINDOW_FLASH_NOTIFY_TARGET_PID) {
  [void][int]::TryParse($env:WINDOW_FLASH_NOTIFY_TARGET_PID, [ref]$targetProcessId)
}

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class WindowFlashNotifyUser32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO {
    public UInt32 cbSize;
    public IntPtr hwnd;
    public UInt32 dwFlags;
    public UInt32 uCount;
    public UInt32 dwTimeout;
  }

  [DllImport("user32.dll")]
  public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$workspaceHints = New-Object System.Collections.Generic.List[string]
function Add-WorkspaceHint([string]$hint) {
  if ([string]::IsNullOrWhiteSpace($hint)) {
    return
  }

  $trimmed = $hint.Trim()
  if ($trimmed -in @('VS Code', 'Visual Studio Code', 'Code', 'Code - Insiders', 'VSCodium')) {
    return
  }

  foreach ($existing in $workspaceHints) {
    if ([string]::Equals($existing, $trimmed, [System.StringComparison]::OrdinalIgnoreCase)) {
      return
    }
  }

  [void]$workspaceHints.Add($trimmed)
}

Add-WorkspaceHint $workspace
if (-not [string]::IsNullOrWhiteSpace($workspaceHintsRaw)) {
  foreach ($hint in ($workspaceHintsRaw -split [string][char]10)) {
    Add-WorkspaceHint $hint
  }
}

$processInfoCache = @{}
function Get-WindowFlashProcessInfo([int]$processIdValue) {
  if ($processIdValue -le 0) {
    return $null
  }

  $key = [string]$processIdValue
  if ($processInfoCache.ContainsKey($key)) {
    return $processInfoCache[$key]
  }

  $cim = $null
  try {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$processIdValue" -ErrorAction Stop
  } catch {
    try {
      $cim = Get-WmiObject Win32_Process -Filter "ProcessId=$processIdValue" -ErrorAction Stop
    } catch {
      $cim = $null
    }
  }

  if ($null -eq $cim) {
    try {
      $basic = Get-Process -Id $processIdValue -ErrorAction Stop
      $info = [pscustomobject]@{
        ProcessId = [int]$processIdValue
        ParentProcessId = 0
        Name = [string]$basic.ProcessName
        CommandLine = ''
      }
    } catch {
      $info = $null
    }
  } else {
    $parentId = 0
    if ($null -ne $cim.ParentProcessId) {
      $parentId = [int]$cim.ParentProcessId
    }
    $info = [pscustomobject]@{
      ProcessId = [int]$cim.ProcessId
      ParentProcessId = $parentId
      Name = [string]$cim.Name
      CommandLine = [string]$cim.CommandLine
    }
  }

  $processInfoCache[$key] = $info
  return $info
}

function Get-WindowFlashProcessChain([int]$processIdValue) {
  $chain = New-Object System.Collections.Generic.List[object]
  $seen = @{}
  $current = $processIdValue

  while ($current -gt 0 -and -not $seen.ContainsKey([string]$current)) {
    $seen[[string]$current] = $true
    $info = Get-WindowFlashProcessInfo $current
    if ($null -eq $info) {
      break
    }

    [void]$chain.Add($info)
    $current = [int]$info.ParentProcessId
  }

  return $chain.ToArray()
}

function Get-WindowFlashProcessChainIds([int]$processIdValue) {
  $ids = New-Object System.Collections.Generic.List[int]
  foreach ($processInfo in @(Get-WindowFlashProcessChain $processIdValue)) {
    [void]$ids.Add([int]$processInfo.ProcessId)
  }
  return $ids.ToArray()
}

function Get-WindowFlashChainScore([int[]]$candidateChainIds, [int[]]$targetChainIds) {
  if ($null -eq $candidateChainIds -or $null -eq $targetChainIds) {
    return 0
  }

  for ($candidateIndex = 0; $candidateIndex -lt $candidateChainIds.Count; $candidateIndex++) {
    for ($targetIndex = 0; $targetIndex -lt $targetChainIds.Count; $targetIndex++) {
      if ($candidateChainIds[$candidateIndex] -eq $targetChainIds[$targetIndex]) {
        return 10000 - (($candidateIndex + $targetIndex) * 100)
      }
    }
  }

  return 0
}

function Test-WindowFlashWorkspaceTitleMatch([string]$title) {
  foreach ($hint in $workspaceHints) {
    if ($title.IndexOf($hint, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      return $true
    }
  }
  return $false
}

function Test-WindowFlashCodeTitle([string]$title) {
  if ($title -match 'Visual Studio Code|VSCodium|Code - Insiders') {
    return $true
  }

  if (-not [string]::IsNullOrWhiteSpace($product) -and
      $title.IndexOf($product, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
    return $true
  }

  return $false
}

function Get-WindowFlashCodeWindows {
  $windows = New-Object System.Collections.Generic.List[object]
  $targetChainIds = @(Get-WindowFlashProcessChainIds $targetProcessId)

  $callback = [WindowFlashNotifyUser32+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)

    if (-not [WindowFlashNotifyUser32]::IsWindowVisible($hWnd)) {
      return $true
    }

    $builder = New-Object System.Text.StringBuilder 1024
    [void][WindowFlashNotifyUser32]::GetWindowText($hWnd, $builder, $builder.Capacity)
    $title = $builder.ToString()
    if ([string]::IsNullOrWhiteSpace($title)) {
      return $true
    }

    [uint32]$windowProcessId = 0
    [void][WindowFlashNotifyUser32]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
    $processInfo = Get-WindowFlashProcessInfo ([int]$windowProcessId)
    if ($null -eq $processInfo) {
      return $true
    }

    $processName = [string]$processInfo.Name
    if ($processName -notlike 'Code*' -and $processName -notlike 'VSCodium*') {
      return $true
    }

    if (-not (Test-WindowFlashCodeTitle $title)) {
      return $true
    }

    $chain = @(Get-WindowFlashProcessChain ([int]$windowProcessId))
    $chainIds = @($chain | ForEach-Object { [int]$_.ProcessId })
    $workspaceMatch = Test-WindowFlashWorkspaceTitleMatch $title
    $score = Get-WindowFlashChainScore -candidateChainIds $chainIds -targetChainIds $targetChainIds

    [void]$windows.Add([pscustomobject]@{
      Hwnd = $hWnd.ToInt64()
      Title = $title
      ProcessId = [int]$windowProcessId
      ProcessName = $processName
      ProcessMatchScore = $score
      WorkspaceMatch = $workspaceMatch
      Chain = @($chain)
    })

    return $true
  }

  [void][WindowFlashNotifyUser32]::EnumWindows($callback, [IntPtr]::Zero)
  return $windows.ToArray()
}

function Select-WindowFlashTargets {
  $windows = @(Get-WindowFlashCodeWindows)
  if ($windows.Count -eq 0) {
    throw "No visible VS Code window was found"
  }

  $processMatches = @($windows | Where-Object { $_.ProcessMatchScore -gt 0 } | Sort-Object -Property ProcessMatchScore -Descending)
  if ($processMatches.Count -gt 0) {
    $bestScore = [int]$processMatches[0].ProcessMatchScore
    $bestMatches = @($processMatches | Where-Object { [int]$_.ProcessMatchScore -eq $bestScore })
    if ($bestMatches.Count -eq 1) {
      return [pscustomobject]@{
        Source = 'processChain'
        Targets = @($bestMatches)
        Windows = @($windows)
        Reason = "Unique process-chain match with score $bestScore."
      }
    }
  }

  if ($workspaceHints.Count -gt 0) {
    $hintMatches = @($windows | Where-Object { $_.WorkspaceMatch })
    if ($hintMatches.Count -gt 0) {
      return [pscustomobject]@{
        Source = 'workspaceHintsFallback'
        Targets = @($hintMatches)
        Windows = @($windows)
        Reason = 'Process-chain match was unavailable or ambiguous; workspace hints matched.'
      }
    }
  }

  if ($windows.Count -eq 1 -and $processMatches.Count -eq 0 -and $workspaceHints.Count -eq 0) {
    return [pscustomobject]@{
      Source = 'singleVisibleWindowFallback'
      Targets = @($windows)
      Windows = @($windows)
      Reason = 'Only one visible VS Code window was available.'
    }
  }

  $titleText = [string]::Join('; ', @($windows | ForEach-Object { $_.Title }))
  $hintText = [string]::Join(', ', $workspaceHints)
  if ($processMatches.Count -gt 1) {
    $bestScore = [int]$processMatches[0].ProcessMatchScore
    throw "Process-chain match was ambiguous at score $bestScore and workspace hints did not resolve it. Hints: $hintText. Visible VS Code title(s): $titleText"
  }

  throw "No VS Code window matched process chain or workspace hint(s): $hintText. Visible VS Code title(s): $titleText"
}
`;
}

function getWindowActionPowerShell(): string {
  return `
${getWindowLookupPowerShell()}

$action = $env:WINDOW_FLASH_NOTIFY_ACTION
$untilForeground = $env:WINDOW_FLASH_NOTIFY_UNTIL_FOREGROUND -eq '1'
$flashCount = 8
if ($env:WINDOW_FLASH_NOTIFY_COUNT) {
  [void][int]::TryParse($env:WINDOW_FLASH_NOTIFY_COUNT, [ref]$flashCount)
}

$selection = Select-WindowFlashTargets
$targets = @($selection.Targets)

foreach ($target in $targets) {
  $hwnd = [System.IntPtr]::new([int64]$target.Hwnd)
  if ($action -eq 'focus') {
    [void][WindowFlashNotifyUser32]::ShowWindowAsync($hwnd, 9)
    [void][WindowFlashNotifyUser32]::SetForegroundWindow($hwnd)
  } elseif ($action -eq 'flash') {
    $info = New-Object WindowFlashNotifyUser32+FLASHWINFO
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
    $info.hwnd = $hwnd
    if ($untilForeground) {
      $info.dwFlags = 0x00000003 -bor 0x0000000C
      $info.uCount = 0
    } else {
      $info.dwFlags = 0x00000003
      $info.uCount = [uint32]$flashCount
    }
    $info.dwTimeout = 0
    [void][WindowFlashNotifyUser32]::FlashWindowEx([ref]$info)
  }
}
`;
}

function getWindowDiagnosticsPowerShell(): string {
  return `
${getWindowLookupPowerShell()}

$selection = $null
$selectionError = $null
try {
  $selection = Select-WindowFlashTargets
} catch {
  $selectionError = $_.Exception.Message
}

$selectionSummary = $null
if ($null -ne $selection) {
  $selectionSummary = [pscustomobject]@{
    Source = $selection.Source
    Reason = $selection.Reason
    TargetCount = @($selection.Targets).Count
    Targets = @($selection.Targets | ForEach-Object {
      [pscustomobject]@{
        Hwnd = $_.Hwnd
        Title = $_.Title
        ProcessId = $_.ProcessId
        ProcessName = $_.ProcessName
        ProcessMatchScore = $_.ProcessMatchScore
        WorkspaceMatch = $_.WorkspaceMatch
      }
    })
  }
}

$result = [pscustomobject]@{
  TargetProcessId = $targetProcessId
  TargetProcessChain = @(Get-WindowFlashProcessChain $targetProcessId)
  WorkspaceHints = @($workspaceHints)
  Selection = $selectionSummary
  SelectionError = $selectionError
  Windows = @(Get-WindowFlashCodeWindows)
}

$result | ConvertTo-Json -Depth 8
`;
}

async function runPowerShell(script: string, env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<void> {
  await runPowerShellWithOutput(script, env, timeoutMs);
}

async function runPowerShellCapture(
  script: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 5000
): Promise<string> {
  const result = await runPowerShellWithOutput(script, env, timeoutMs);
  return result.stdout;
}

function runPowerShellWithOutput(
  script: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded
    ], {
      env,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("PowerShell window action timed out")));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("exit", (code) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
        }
      });
    });
  });
}

function spawnPowerShellDetached(script: string, env: NodeJS.ProcessEnv): void {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded
  ], {
    env,
    windowsHide: true,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function getWorkspaceMatchHints(
  workspaceName?: string,
  workspacePath?: string,
  providedHints: string[] = []
): string[] {
  const hints: string[] = [];
  const addHint = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (!trimmed || isGenericWorkspaceHint(trimmed)) {
      return;
    }

    if (!hints.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      hints.push(trimmed);
    }
  };

  const addNameVariants = (value: string | undefined): void => {
    addHint(value);
    addHint(stripRemoteSuffix(value));
  };

  for (const hint of providedHints) {
    addNameVariants(hint);
    addHint(basenameFromAnyPath(hint));
  }

  addNameVariants(workspaceName);
  addNameVariants(getWorkspaceName());
  addHint(workspacePath);
  addHint(basenameFromAnyPath(workspacePath));

  for (const folder of vscode.workspace.workspaceFolders || []) {
    addNameVariants(folder.name);
    addHint(folder.uri.fsPath);
    addHint(folder.uri.path);
    addHint(basenameFromAnyPath(folder.uri.fsPath));
    addHint(basenameFromAnyPath(folder.uri.path));
  }

  return hints;
}

function stripRemoteSuffix(value: string | undefined): string | undefined {
  return value?.replace(/\s+\[[^\]]+\]\s*$/, "");
}

function basenameFromAnyPath(value: string | undefined): string | undefined {
  return value?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
}

function isGenericWorkspaceHint(value: string): boolean {
  return ["vs code", "visual studio code", "code", "code - insiders", "vscodium"].includes(
    value.toLowerCase()
  );
}

function getWorkspaceName(): string {
  if (vscode.workspace.name) {
    return vscode.workspace.name;
  }

  const firstFolder = vscode.workspace.workspaceFolders?.[0];
  if (firstFolder) {
    return basename(firstFolder.uri.path || firstFolder.uri.fsPath);
  }

  return "VS Code";
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("windowFlashNotify");
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
