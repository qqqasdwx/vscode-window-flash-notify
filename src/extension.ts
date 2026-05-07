import { spawn } from "node:child_process";
import { basename } from "node:path";
import * as vscode from "vscode";

type NotifyType = "info" | "warning" | "error";
type NotifyAction = "flash" | "focus" | "none";

interface NotifyPayload {
  message?: string;
  type?: NotifyType;
  action?: NotifyAction;
  workspaceName?: string;
  workspacePath?: string;
  workspaceHints?: string[];
  showInternalNotification?: boolean;
}

interface NotifyResult {
  success: true;
  action: NotifyAction;
  workspaceName: string;
  workspaceHints: string[];
  platform: NodeJS.Platform;
}

const output = vscode.window.createOutputChannel("Window Flash Notify");

export function activate(context: vscode.ExtensionContext): void {
  output.appendLine("Activating Window Flash Notify UI");

  context.subscriptions.push(output);
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
}

export function deactivate(): void {
  output.appendLine("Deactivating Window Flash Notify UI");
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
  const workspaceName = workspaceHints[0] || getWorkspaceName();

  output.appendLine(
    `Notify: action=${action} type=${type} workspace=${workspaceName} hints=${workspaceHints.join("|")} message=${message}`
  );

  if (action === "flash") {
    await runWindowsWindowAction("flash", workspaceHints);
  } else if (action === "focus") {
    await runWindowsWindowAction("focus", workspaceHints);
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

async function runWindowsWindowAction(action: "flash" | "focus", workspaceHints: string[]): Promise<void> {
  if (process.platform !== "win32") {
    output.appendLine(`Skipping ${action}; platform is ${process.platform}`);
    return;
  }

  const config = getConfig();
  const flashUntilForeground = config.get<boolean>("flashUntilForeground", true);
  const flashCount = config.get<number>("flashCount", 8);

  const env = {
    ...process.env,
    WINDOW_FLASH_NOTIFY_ACTION: action,
    WINDOW_FLASH_NOTIFY_WORKSPACE: workspaceHints[0] || "",
    WINDOW_FLASH_NOTIFY_WORKSPACE_HINTS: workspaceHints.join("\n"),
    WINDOW_FLASH_NOTIFY_UNTIL_FOREGROUND: flashUntilForeground ? "1" : "0",
    WINDOW_FLASH_NOTIFY_COUNT: String(flashCount)
  };

  await runPowerShell(getWindowActionPowerShell(), env);
}

function getWindowActionPowerShell(): string {
  return `
$ErrorActionPreference = 'Stop'
$action = $env:WINDOW_FLASH_NOTIFY_ACTION
$workspace = $env:WINDOW_FLASH_NOTIFY_WORKSPACE
$workspaceHintsRaw = $env:WINDOW_FLASH_NOTIFY_WORKSPACE_HINTS
$untilForeground = $env:WINDOW_FLASH_NOTIFY_UNTIL_FOREGROUND -eq '1'
$flashCount = 8
if ($env:WINDOW_FLASH_NOTIFY_COUNT) {
  [void][int]::TryParse($env:WINDOW_FLASH_NOTIFY_COUNT, [ref]$flashCount)
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

$matching = New-Object System.Collections.Generic.List[System.IntPtr]
$visibleCodeTitles = New-Object System.Collections.Generic.List[string]

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
  try {
    $process = Get-Process -Id $windowProcessId -ErrorAction Stop
  } catch {
    return $true
  }

  if ($process.ProcessName -notlike 'Code*' -and $process.ProcessName -notlike 'VSCodium*') {
    return $true
  }

  if ($title -notmatch 'Visual Studio Code|VSCodium|Code - Insiders') {
    return $true
  }

  [void]$visibleCodeTitles.Add($title)

  foreach ($hint in $workspaceHints) {
    if ($title.IndexOf($hint, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      [void]$matching.Add($hWnd)
      break
    }
  }

  return $true
}

[void][WindowFlashNotifyUser32]::EnumWindows($callback, [IntPtr]::Zero)

if ($workspaceHints.Count -eq 0) {
  throw "No workspace hint was available; refusing to target every VS Code window"
}

if ($visibleCodeTitles.Count -eq 0) {
  throw "No visible VS Code window was found"
}

if ($matching.Count -eq 0) {
  $hintText = [string]::Join(', ', $workspaceHints)
  $titleText = [string]::Join('; ', $visibleCodeTitles)
  throw "No VS Code window matched workspace hint(s): $hintText. Visible VS Code title(s): $titleText"
}

foreach ($hwnd in $matching) {
  if ($action -eq 'focus') {
    [void][WindowFlashNotifyUser32]::ShowWindowAsync($hwnd, 9)
    [void][WindowFlashNotifyUser32]::SetForegroundWindow($hwnd)
  } else {
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

async function runPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<void> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  await new Promise<void>((resolve, reject) => {
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

    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("PowerShell window action timed out"));
    }, 5000);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
      }
    });
  });
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
