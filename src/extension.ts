import * as http from "node:http";
import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { basename } from "node:path";

type NotifyType = "info" | "warning" | "error";
type NotifyAction = "flash" | "focus" | "none";

interface NotifyPayload {
  message?: string;
  title?: string;
  type?: NotifyType;
  action?: NotifyAction;
  workspacePath?: string;
  workspaceName?: string;
  showInternalNotification?: boolean;
  showToast?: boolean;
  toastTimeout?: number;
}

interface PortInfo {
  port: number;
  listenHost: string;
  gatewayHost: string;
  endpoints: {
    local: string;
    gateway: string;
  };
  workspaceName: string;
  pid: number;
  platform: NodeJS.Platform;
  timestamp: string;
  tokenRequired: boolean;
}

let server: http.Server | undefined;
let activePort: number | undefined;
let activePortInfo: PortInfo | undefined;
const output = vscode.window.createOutputChannel("Window Flash Notify");
let extensionId = "qqqasdwx.vscode-window-flash-notify";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionId = context.extension.id;
  output.appendLine("Activating Window Flash Notify");

  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        output.appendLine(`URI received: ${uri.toString(true)}`);
        const params = new URLSearchParams(uri.query);
        const workspaceName = params.get("workspaceName") || getWorkspaceName();
        await runWindowsWindowAction("focus", workspaceName);
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("windowFlashNotify.testFlash", async () => {
    await handleNotification({
      message: "Test notification",
      type: "info",
      action: "flash",
      showToast: true
    });
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("windowFlashNotify.copyCurlCommand", async () => {
      const command = buildCurlCommand();
      await vscode.env.clipboard.writeText(command);
      vscode.window.showInformationMessage("Window Flash Notify curl command copied.");
    })
  );

  await startServer();

  context.subscriptions.push({
    dispose: () => {
      void stopServer();
    }
  });
}

export async function deactivate(): Promise<void> {
  await stopServer();
}

async function startServer(): Promise<void> {
  const config = getConfig();
  const basePort = config.get<number>("basePort", 7531);
  const range = config.get<number>("portSearchRange", 10);
  const listenHost = config.get<string>("listenHost", "127.0.0.1");

  const port = await findAvailablePort(basePort, range, listenHost);
  server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    if (!server) {
      reject(new Error("Server was not initialized"));
      return;
    }

    server.once("error", reject);
    server.listen(port, listenHost, () => {
      server?.off("error", reject);
      resolve();
    });
  });

  activePort = port;
  activePortInfo = makePortInfo(port, listenHost);
  output.appendLine(`Listening on http://${listenHost}:${port}`);

  if (config.get<boolean>("writePortFile", true)) {
    await writePortFiles(activePortInfo);
  }
}

async function stopServer(): Promise<void> {
  const runningServer = server;
  server = undefined;

  if (runningServer) {
    await new Promise<void>((resolve) => runningServer.close(() => resolve()));
  }

  await removePortFiles();
  activePort = undefined;
  activePortInfo = undefined;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    if (req.method === "GET" && req.url?.startsWith("/health")) {
      sendJson(res, 200, { ok: true, port: activePort, workspaceName: getWorkspaceName() });
      return;
    }

    if (req.method !== "POST" || !req.url?.startsWith("/notify")) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const raw = await readRequestBody(req);
    const payload = parsePayload(raw);
    await handleNotification(payload);
    sendJson(res, 200, { success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Request failed: ${message}`);
    sendJson(res, 400, { error: message });
  }
}

async function handleNotification(payload: NotifyPayload): Promise<void> {
  const message = payload.message || "Notification received";
  const action = payload.action || "flash";
  const type = payload.type || "info";
  const workspaceName = payload.workspaceName || getWorkspaceName();

  output.appendLine(`Notify: action=${action} type=${type} workspace=${workspaceName} message=${message}`);

  if (action === "flash") {
    await runWindowsWindowAction("flash", workspaceName);
  } else if (action === "focus") {
    await runWindowsWindowAction("focus", workspaceName);
  }

  const showToast = payload.showToast ?? getConfig().get<boolean>("showToast", false);
  if (showToast) {
    await showToastNotification(payload, workspaceName);
  }

  const showInternal =
    payload.showInternalNotification ?? getConfig().get<boolean>("showInternalNotification", false);

  if (showInternal) {
    await showInternalNotification(type, `[${workspaceName}] ${message}`, workspaceName);
  }
}

async function showToastNotification(payload: NotifyPayload, workspaceName: string): Promise<void> {
  if (process.platform !== "win32") {
    output.appendLine(`Skipping native toast; platform is ${process.platform}`);
    return;
  }

  const message = payload.message || "Notification received";
  const title = payload.title || `${workspaceName} - Window Flash Notify`;
  const timeout = payload.toastTimeout ?? getConfig().get<number>("toastTimeout", 15);
  const focusUri = buildFocusUri(workspaceName);

  output.appendLine(`Showing protocol toast: ${focusUri}`);
  await runProtocolToastPowerShell(title, message, focusUri, timeout);
}

function buildFocusUri(workspaceName: string): string {
  const uri = vscode.Uri.from({
    scheme: vscode.env.uriScheme,
    authority: extensionId,
    path: "/focus",
    query: new URLSearchParams({ workspaceName }).toString()
  });
  return uri.toString(true);
}

async function runProtocolToastPowerShell(
  title: string,
  message: string,
  focusUri: string,
  timeout: number
): Promise<void> {
  const env = {
    ...process.env,
    WINDOW_FLASH_NOTIFY_TOAST_TITLE: title,
    WINDOW_FLASH_NOTIFY_TOAST_MESSAGE: message,
    WINDOW_FLASH_NOTIFY_TOAST_URI: focusUri,
    WINDOW_FLASH_NOTIFY_TOAST_TIMEOUT: String(timeout)
  };

  await runPowerShell(getProtocolToastPowerShell(), env);
}

function getProtocolToastPowerShell(): string {
  return `
$ErrorActionPreference = 'Stop'

$title = $env:WINDOW_FLASH_NOTIFY_TOAST_TITLE
$message = $env:WINDOW_FLASH_NOTIFY_TOAST_MESSAGE
$uri = $env:WINDOW_FLASH_NOTIFY_TOAST_URI

function Escape-Xml([string]$value) {
  return [System.Security.SecurityElement]::Escape($value)
}

$escapedTitle = Escape-Xml $title
$escapedMessage = Escape-Xml $message
$escapedUri = Escape-Xml $uri

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$xmlText = @"
<toast activationType="protocol" launch="$escapedUri">
  <visual>
    <binding template="ToastGeneric">
      <text>$escapedTitle</text>
      <text>$escapedMessage</text>
    </binding>
  </visual>
  <actions>
    <action content="Focus VS Code" activationType="protocol" arguments="$escapedUri" />
  </actions>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Visual Studio Code")
$notifier.Show($toast)
`;
}

async function showInternalNotification(type: NotifyType, message: string, workspaceName: string): Promise<void> {
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
    await runWindowsWindowAction("focus", workspaceName);
  } else if (selected === flashAgain) {
    await runWindowsWindowAction("flash", workspaceName);
  }
}

async function runWindowsWindowAction(action: "flash" | "focus", workspaceName: string): Promise<void> {
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
    WINDOW_FLASH_NOTIFY_WORKSPACE: workspaceName,
    WINDOW_FLASH_NOTIFY_PRODUCT: vscode.env.appName,
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
$product = $env:WINDOW_FLASH_NOTIFY_PRODUCT
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

$matching = New-Object System.Collections.Generic.List[System.IntPtr]
$fallback = New-Object System.Collections.Generic.List[System.IntPtr]

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

  [void]$fallback.Add($hWnd)

  if (-not [string]::IsNullOrWhiteSpace($workspace) -and
      $title.IndexOf($workspace, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
    [void]$matching.Add($hWnd)
  }

  return $true
}

[void][WindowFlashNotifyUser32]::EnumWindows($callback, [IntPtr]::Zero)

if ($matching.Count -gt 0) {
  $targets = $matching
} else {
  $targets = $fallback
}

if ($targets.Count -eq 0) {
  throw "No visible VS Code window was found"
}

foreach ($hwnd in $targets) {
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

function isAuthorized(req: http.IncomingMessage): boolean {
  const token = getConfig().get<string>("authToken", "");
  if (!token) {
    return true;
  }

  const header = req.headers["x-window-flash-token"];
  if (header === token) {
    return true;
  }

  const url = new URL(req.url || "/", "http://localhost");
  return url.searchParams.get("token") === token;
}

function parsePayload(raw: string): NotifyPayload {
  if (!raw.trim()) {
    return {};
  }

  const parsed = JSON.parse(raw) as NotifyPayload;
  if (parsed.type && !["info", "warning", "error"].includes(parsed.type)) {
    throw new Error(`Invalid notification type: ${parsed.type}`);
  }
  if (parsed.action && !["flash", "focus", "none"].includes(parsed.action)) {
    throw new Error(`Invalid action: ${parsed.action}`);
  }
  return parsed;
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function findAvailablePort(startPort: number, range: number, listenHost: string): Promise<number> {
  const attempts = Array.from({ length: range }, (_, index) => startPort + index);

  return attempts.reduce<Promise<number>>(
    (previous, port) =>
      previous.catch(() =>
        new Promise<number>((resolve, reject) => {
          const probe = http.createServer();
          probe.once("error", reject);
          probe.listen(port, listenHost, () => {
            probe.close(() => resolve(port));
          });
        })
      ),
    Promise.reject(new Error("No port tried yet"))
  ).catch(() => {
    throw new Error(`No available port found in ${startPort}-${startPort + range - 1}`);
  });
}

function makePortInfo(port: number, listenHost: string): PortInfo {
  const gatewayHost = getConfig().get<string>("gatewayHost", "10.0.2.2");
  const token = getConfig().get<string>("authToken", "");

  return {
    port,
    listenHost,
    gatewayHost,
    endpoints: {
      local: `http://${listenHost}:${port}/notify`,
      gateway: `http://${gatewayHost}:${port}/notify`
    },
    workspaceName: getWorkspaceName(),
    pid: process.pid,
    platform: process.platform,
    timestamp: new Date().toISOString(),
    tokenRequired: token.length > 0
  };
}

async function writePortFiles(portInfo: PortInfo): Promise<void> {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    try {
      const vscodeDir = vscode.Uri.joinPath(folder.uri, ".vscode");
      const portFile = vscode.Uri.joinPath(vscodeDir, "window-flash-notify-port.json");
      await vscode.workspace.fs.createDirectory(vscodeDir);
      await vscode.workspace.fs.writeFile(
        portFile,
        Buffer.from(JSON.stringify(portInfo, null, 2), "utf8")
      );
      output.appendLine(`Wrote ${portFile.toString()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Failed to write port file for ${folder.uri.toString()}: ${message}`);
    }
  }
}

async function removePortFiles(): Promise<void> {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const portFile = vscode.Uri.joinPath(folder.uri, ".vscode", "window-flash-notify-port.json");
    try {
      const data = await vscode.workspace.fs.readFile(portFile);
      const parsed = JSON.parse(Buffer.from(data).toString("utf8")) as { pid?: number };
      if (parsed.pid === process.pid) {
        await vscode.workspace.fs.delete(portFile);
      }
    } catch {
      // Ignore missing or stale files.
    }
  }
}

function buildCurlCommand(): string {
  const endpoint = activePortInfo?.endpoints.gateway || "http://10.0.2.2:7531/notify";
  const message = "Window Flash Notify test";
  const token = getConfig().get<string>("authToken", "");
  const tokenHeader = token ? ` \\\n  -H 'X-Window-Flash-Token: ${shellSingleQuote(token)}'` : "";

  return `curl -fsS -X POST '${endpoint}' \\\n  -H 'Content-Type: application/json'${tokenHeader} \\\n  --data '{"message":"${message}","type":"info","action":"flash","showToast":true}'`;
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

function shellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\"'\"'");
}
