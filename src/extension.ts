import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
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
  relayRequestId?: string;
  relayCallbackUri?: string;
  relayCallbackToken?: string;
}

interface NotifyResult {
  success: true;
  action: NotifyAction;
  workspaceName: string;
  workspaceHints: string[];
  platform: NodeJS.Platform;
  implementation: string;
}

interface UiHealthResult {
  ok: true;
  role: "ui";
  id: string;
  version: string;
  platform: NodeJS.Platform;
  implementation: string;
}

const defaultExtensionId = "qqqasdwx.vscode-window-flash-notify";
const relayExtensionId = "qqqasdwx.vscode-window-flash-notify-relay";
const relayPrimaryCommand = "windowFlashNotifyRelay.testFlash";
const minimumRelayVersion = "0.2.17";
const focusProtocolScheme = "windowflashnotify";
const implementation = "delayed-detached-script";
const output = vscode.window.createOutputChannel("Window Flash Notify");
const customSoundFileName = "notification.wav";
const customSoundMaxBytes = 10 * 1024 * 1024;

let extensionId = defaultExtensionId;
let extensionVersion = "unknown";
let extensionContext: vscode.ExtensionContext | undefined;
let relayPromptInProgress = false;
let relayPromptShownThisSession = false;
let focusProtocolRegistration: Promise<boolean> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  extensionId = context.extension.id || defaultExtensionId;
  extensionVersion = getExtensionVersion(context);
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
    vscode.commands.registerCommand("windowFlashNotify.health", async () => {
      return getUiHealthResult();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("windowFlashNotify.installRelay", async () => {
      await promptInstallRelay(context, true);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("windowFlashNotify.selectSound", async () => {
      await selectNotificationSound(context);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("windowFlashNotify.clearSound", async () => {
      await clearNotificationSound(context);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("windowFlashNotify.testSound", async () => {
      await testNotificationSound();
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
        message: vscode.l10n.t("Test notification"),
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

  scheduleRelayInstallCheck(context);
  if (process.platform === "win32") {
    void ensureFocusProtocolRegistered(context);
  }
}

export function deactivate(): void {
  output.appendLine("Deactivating Window Flash Notify UI");
}

async function handleExtensionUri(uri: vscode.Uri): Promise<void> {
  output.appendLine(`URI received: ${uri.toString(true)}`);
  if (uri.path === "/health") {
    await postRelayAck(readRelayAckFromUri(uri), getUiHealthResult());
    return;
  }

  if (uri.path === "/notify") {
    try {
      const payload = parseUriNotifyPayload(uri);
      const result = await handleNotification(payload);
      await postRelayAck(payload, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`URI notify failed: ${message}`);
    }
    return;
  }

  if (uri.path !== "/focus") {
    return;
  }

  const params = new URLSearchParams(uri.query);
  const workspaceName = params.get("workspaceName") || undefined;
  const workspaceHints = getWorkspaceMatchHintsFromUri(
    workspaceName,
    params.getAll("workspaceHint")
  );
  const targetProcessId = parsePositiveInteger(params.get("targetPid")) || process.pid;

  runWindowsWindowAction("focus", workspaceHints, targetProcessId);
}

function parseUriNotifyPayload(uri: vscode.Uri): NotifyPayload {
  const params = new URLSearchParams(uri.query);
  const encodedPayload = params.get("payload");
  if (!encodedPayload) {
    return {};
  }

  const parsed = JSON.parse(Buffer.from(encodedPayload, "base64").toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("URI notify payload must be an object");
  }

  return normalizeNotifyPayload(parsed as Record<string, unknown>);
}

function normalizeNotifyPayload(record: Record<string, unknown>): NotifyPayload {
  const payload: NotifyPayload = {};

  payload.title = readOptionalString(record, "title");
  payload.message = readOptionalString(record, "message");
  payload.type = readOptionalNotifyType(record.type);
  payload.action = readOptionalNotifyAction(record.action);
  payload.workspaceName = readOptionalString(record, "workspaceName");
  payload.workspacePath = readOptionalString(record, "workspacePath");
  payload.showInternalNotification = readOptionalBoolean(record, "showInternalNotification");
  payload.sound = readOptionalBoolean(record, "sound");
  payload.showToast = readOptionalBoolean(record, "showToast");
  payload.toastTimeout = readOptionalNumber(record, "toastTimeout");
  payload.relayRequestId = readOptionalString(record, "relayRequestId");
  payload.relayCallbackUri = readOptionalString(record, "relayCallbackUri");
  payload.relayCallbackToken = readOptionalString(record, "relayCallbackToken");

  if (record.workspaceHints !== undefined) {
    if (
      !Array.isArray(record.workspaceHints) ||
      record.workspaceHints.some((hint) => typeof hint !== "string")
    ) {
      throw new Error("workspaceHints must be an array of strings");
    }
    payload.workspaceHints = record.workspaceHints;
  }

  return payload;
}

function readRelayAckFromUri(uri: vscode.Uri): Pick<NotifyPayload, "relayRequestId" | "relayCallbackUri" | "relayCallbackToken"> {
  const params = new URLSearchParams(uri.query);
  return {
    relayRequestId: params.get("relayRequestId") || undefined,
    relayCallbackUri: params.get("relayCallbackUri") || undefined,
    relayCallbackToken: params.get("relayCallbackToken") || undefined
  };
}

function getUiHealthResult(): UiHealthResult {
  return {
    ok: true,
    role: "ui",
    id: extensionId,
    version: extensionVersion,
    platform: process.platform,
    implementation
  };
}

async function postRelayAck(
  payload: Pick<NotifyPayload, "relayRequestId" | "relayCallbackUri" | "relayCallbackToken">,
  result: unknown
): Promise<void> {
  if (!payload.relayRequestId || !payload.relayCallbackUri || !payload.relayCallbackToken) {
    return;
  }

  try {
    const response = await fetch(payload.relayCallbackUri, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        requestId: payload.relayRequestId,
        token: payload.relayCallbackToken,
        result
      })
    });

    if (!response.ok) {
      output.appendLine(`Relay ack failed: HTTP ${response.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Relay ack failed: ${message}`);
  }
}

function scheduleRelayInstallCheck(context: vscode.ExtensionContext): void {
  if (!vscode.env.remoteName || !getConfig().get<boolean>("autoInstallRelay", true)) {
    return;
  }

  const timer = setTimeout(() => {
    void promptInstallRelay(context, false);
  }, 2000);

  context.subscriptions.push({
    dispose: () => clearTimeout(timer)
  });
}

async function promptInstallRelay(context: vscode.ExtensionContext, forced: boolean): Promise<void> {
  if (!vscode.env.remoteName || relayPromptInProgress) {
    return;
  }

  relayPromptInProgress = true;
  try {
    const state = await getRelayInstallState();
    if (state.ok) {
      if (forced) {
        vscode.window.showInformationMessage(
          vscode.l10n.t("Window Flash Notify Relay is already installed in this remote window.")
        );
      }
      return;
    }
    if (relayPromptShownThisSession && !forced) {
      return;
    }
    relayPromptShownThisSession = true;

    const installLabel = state.installed ? vscode.l10n.t("Update Relay") : vscode.l10n.t("Install Relay");
    const laterLabel = vscode.l10n.t("Later");
    const message = state.installed
      ? vscode.l10n.t(
        "Window Flash Notify Relay {version} is older than {minimumVersion}. Update it in this remote window.",
        { version: state.version || "", minimumVersion: minimumRelayVersion }
      )
      : vscode.l10n.t(
        "Window Flash Notify Relay is not installed in this remote window. Install it so local terminal scripts can send notifications."
      );

    const choice = await vscode.window.showWarningMessage(message, installLabel, laterLabel);
    if (choice !== installLabel) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${installLabel}: Window Flash Notify Relay`,
        cancellable: false
      },
      async () => {
        await vscode.commands.executeCommand("workbench.extensions.installExtension", relayExtensionId);
      }
    );

    await context.workspaceState.update("windowFlashNotify.lastRelayInstallAttempt", Date.now());
    const reloadLabel = vscode.l10n.t("Reload Window");
    const reloadChoice = await vscode.window.showInformationMessage(
      vscode.l10n.t("Window Flash Notify Relay was installed or updated. Reload this remote window to activate it."),
      reloadLabel,
      laterLabel
    );
    if (reloadChoice === reloadLabel) {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Relay install failed: ${message}`);
    vscode.window.showErrorMessage(
      vscode.l10n.t("Failed to install Window Flash Notify Relay: {message}", { message })
    );
  } finally {
    relayPromptInProgress = false;
  }
}

async function getRelayInstallState(): Promise<{ ok: boolean; installed: boolean; version?: string }> {
  const extension = vscode.extensions.getExtension(relayExtensionId);
  if (extension) {
    const version = getPackageVersionFromPath(extension.extensionUri.fsPath) ?? getPackageJsonVersion(extension.packageJSON);
    return {
      ok: version !== "unknown" && compareVersions(version, minimumRelayVersion) >= 0,
      installed: true,
      version
    };
  }

  const commands = await vscode.commands.getCommands(true);
  if (commands.includes(relayPrimaryCommand)) {
    return {
      ok: true,
      installed: true
    };
  }

  return {
    ok: false,
    installed: false
  };
}

async function handleNotification(payload: NotifyPayload): Promise<NotifyResult> {
  const message = payload.message || getDefaultNotificationMessage();
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
    runWindowsWindowAction("flash", workspaceHints);
  } else if (action === "focus") {
    runWindowsWindowAction("focus", workspaceHints);
  }

  if (payload.sound ?? getConfig().get<boolean>("soundEnabled", false)) {
    playNotificationSound(type);
  }

  if (payload.showToast ?? getConfig().get<boolean>("showToast", false)) {
    await showToastNotification(payload, workspaceName, workspaceHints);
  }

  return {
    success: true,
    action,
    workspaceName,
    workspaceHints,
    platform: process.platform,
    implementation
  };
}

function playNotificationSound(type: NotifyType): void {
  if (process.platform !== "win32") {
    output.appendLine(`Skipping sound; platform is ${process.platform}`);
    return;
  }

  schedulePowerShellDetached("sound", getSoundPowerShell(), {
    ...process.env,
    WINDOW_FLASH_NOTIFY_TYPE: type,
    WINDOW_FLASH_NOTIFY_SOUND_PATH: getConfiguredCustomSoundPath() || ""
  });
}

async function selectNotificationSound(context: vscode.ExtensionContext): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      [vscode.l10n.t("Wave audio")]: ["wav"]
    },
    openLabel: vscode.l10n.t("Select Sound"),
    title: vscode.l10n.t("Select Custom Notification Sound")
  });

  const soundUri = selected?.[0];
  if (!soundUri) {
    return;
  }

  try {
    if (soundUri.scheme !== "file") {
      throw new Error(vscode.l10n.t("Custom notification sound must be a local file."));
    }

    const sourcePath = soundUri.fsPath;
    validateCustomSoundFile(sourcePath);

    const targetPath = getManagedCustomSoundPath(context);
    mkdirSync(getCustomSoundStorageDir(context), { recursive: true });
    if (resolve(sourcePath) !== resolve(targetPath)) {
      copyFileSync(sourcePath, targetPath);
    }
    await getConfig().update("customSoundPath", targetPath, vscode.ConfigurationTarget.Global);

    const testLabel = vscode.l10n.t("Test Sound");
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t("Custom notification sound selected: {name}", { name: basename(sourcePath) }),
      testLabel
    );
    if (choice === testLabel) {
      playNotificationSound("info");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Custom sound selection failed: ${message}`);
    vscode.window.showErrorMessage(
      vscode.l10n.t("Failed to select custom notification sound: {message}", { message })
    );
  }
}

async function clearNotificationSound(context: vscode.ExtensionContext): Promise<void> {
  const currentPath = getCustomSoundConfigPath();
  if (!currentPath) {
    vscode.window.showInformationMessage(vscode.l10n.t("No custom notification sound is configured."));
    return;
  }

  await getConfig().update("customSoundPath", "", vscode.ConfigurationTarget.Global);
  removeManagedCustomSoundFile(context, currentPath);
  vscode.window.showInformationMessage(vscode.l10n.t("Custom notification sound cleared."));
}

async function testNotificationSound(): Promise<void> {
  if (process.platform !== "win32") {
    vscode.window.showWarningMessage(vscode.l10n.t("Notification sounds require Windows."));
    return;
  }

  playNotificationSound("info");
  vscode.window.showInformationMessage(vscode.l10n.t("Notification sound test started."));
}

function validateCustomSoundFile(filePath: string): void {
  if (extname(filePath).toLowerCase() !== ".wav") {
    throw new Error(vscode.l10n.t("Custom notification sound must be a .wav file."));
  }

  const stats = statSync(filePath);
  if (!stats.isFile()) {
    throw new Error(vscode.l10n.t("Custom notification sound must be a local file."));
  }
  if (stats.size <= 0) {
    throw new Error(vscode.l10n.t("Custom notification sound file is empty."));
  }
  if (stats.size > customSoundMaxBytes) {
    throw new Error(vscode.l10n.t(
      "Custom notification sound file is too large. Choose a WAV file up to {maxSizeMb} MB.",
      { maxSizeMb: customSoundMaxBytes / 1024 / 1024 }
    ));
  }

  const header = readFileSync(filePath).subarray(0, 12);
  if (
    header.length < 12 ||
    header.subarray(0, 4).toString("ascii") !== "RIFF" ||
    header.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    throw new Error(vscode.l10n.t("Custom notification sound file is not a valid WAV file."));
  }
}

function getConfiguredCustomSoundPath(): string | undefined {
  const customSoundPath = getCustomSoundConfigPath();
  if (!customSoundPath) {
    return undefined;
  }

  try {
    if (
      extname(customSoundPath).toLowerCase() === ".wav" &&
      existsSync(customSoundPath) &&
      statSync(customSoundPath).isFile()
    ) {
      return customSoundPath;
    }
  } catch {
  }

  output.appendLine(`Custom sound path is unavailable; falling back to system sound: ${customSoundPath}`);
  return undefined;
}

function getCustomSoundConfigPath(): string {
  return getConfig().get<string>("customSoundPath", "").trim();
}

function getManagedCustomSoundPath(context: vscode.ExtensionContext): string {
  return join(getCustomSoundStorageDir(context), customSoundFileName);
}

function getCustomSoundStorageDir(context: vscode.ExtensionContext): string {
  return join(context.globalStorageUri.fsPath, "sounds");
}

function removeManagedCustomSoundFile(context: vscode.ExtensionContext, filePath: string): void {
  if (resolve(filePath) !== resolve(getManagedCustomSoundPath(context))) {
    return;
  }

  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Failed to remove managed custom sound: ${message}`);
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

  const message = payload.message || getDefaultNotificationMessage();
  const title = payload.title || vscode.l10n.t("{workspaceName} - Window Flash Notify", { workspaceName });
  const toastTimeout = clampNumber(
    payload.toastTimeout ?? getConfig().get<number>("toastTimeout", 15),
    0,
    300
  );
  const focusUri = await buildToastFocusUri(workspaceName, workspaceHints, process.pid);

  output.appendLine(`Showing toast: ${title} - ${message}`);
  schedulePowerShellDetached("toast", getToastPowerShell(), {
    ...process.env,
    WINDOW_FLASH_NOTIFY_TOAST_TITLE: title,
    WINDOW_FLASH_NOTIFY_TOAST_MESSAGE: message,
    WINDOW_FLASH_NOTIFY_TOAST_TIMEOUT: String(toastTimeout),
    WINDOW_FLASH_NOTIFY_TOAST_FOCUS_URI: focusUri,
    WINDOW_FLASH_NOTIFY_TOAST_ACTION: vscode.l10n.t("Focus VS Code"),
    WINDOW_FLASH_NOTIFY_PRODUCT: vscode.env.appName || "Visual Studio Code"
  });
}

function getDefaultNotificationMessage(): string {
  return vscode.l10n.t("Notification received");
}

async function buildToastFocusUri(
  workspaceName: string,
  workspaceHints: string[],
  targetProcessId: number
): Promise<string> {
  if (extensionContext && await ensureFocusProtocolRegistered(extensionContext)) {
    return buildCustomFocusUri(workspaceName, workspaceHints, targetProcessId);
  }

  return buildFocusUri(workspaceName, workspaceHints, targetProcessId);
}

function buildCustomFocusUri(
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

  return `${focusProtocolScheme}://focus?${params.toString()}`;
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

async function ensureFocusProtocolRegistered(context: vscode.ExtensionContext): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }

  if (!focusProtocolRegistration) {
    focusProtocolRegistration = registerFocusProtocol(context).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Failed to register ${focusProtocolScheme} protocol: ${message}`);
      return false;
    });
  }

  return focusProtocolRegistration;
}

async function registerFocusProtocol(context: vscode.ExtensionContext): Promise<boolean> {
  const scriptPath = writeFocusProtocolScripts(context);
  const wscriptPath = getWindowsWScriptPath();
  const command = `"${wscriptPath}" "${scriptPath}" "%1"`;
  const rootKey = `HKCU\\Software\\Classes\\${focusProtocolScheme}`;

  await runHiddenProcess("reg.exe", ["add", rootKey, "/ve", "/d", "URL:Window Flash Notify Protocol", "/f"]);
  await runHiddenProcess("reg.exe", ["add", rootKey, "/v", "URL Protocol", "/d", "", "/f"]);
  await runHiddenProcess("reg.exe", ["add", `${rootKey}\\shell\\open\\command`, "/ve", "/d", command, "/f"]);
  return true;
}

function writeFocusProtocolScripts(context: vscode.ExtensionContext): string {
  const dir = context.globalStorageUri.fsPath;
  mkdirSync(dir, { recursive: true });
  const powerShellPath = getWindowsPowerShellPath();
  const powerShellScriptPath = join(dir, "focus-protocol.ps1");
  const vbsScriptPath = join(dir, "focus-protocol.vbs");
  writeFileSync(powerShellScriptPath, getFocusProtocolPowerShell(), "utf8");
  writeFileSync(vbsScriptPath, getFocusProtocolVbs(powerShellPath, powerShellScriptPath), "utf8");
  return vbsScriptPath;
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

function runWindowsWindowAction(
  action: "flash" | "focus",
  workspaceHints: string[],
  targetProcessId = process.pid
): void {
  if (process.platform !== "win32") {
    output.appendLine(`Skipping ${action}; platform is ${process.platform}`);
    return;
  }

  schedulePowerShellDetached(
    `window-${action}`,
    getWindowActionPowerShell(),
    getWindowActionEnv(action, workspaceHints, targetProcessId)
  );
}

function getWindowActionEnv(
  action: NotifyAction,
  workspaceHints: string[],
  targetProcessId: number
): NodeJS.ProcessEnv {
  const config = getConfig();
  const flashUntilForeground = config.get<boolean>("flashUntilForeground", true);
  const flashCount = config.get<number>("flashCount", 8);
  const useProcessChainTieBreaker = config.get<boolean>("useProcessChainTieBreaker", false);

  return {
    ...process.env,
    WINDOW_FLASH_NOTIFY_ACTION: action,
    WINDOW_FLASH_NOTIFY_TARGET_PID: String(targetProcessId),
    WINDOW_FLASH_NOTIFY_WORKSPACE: workspaceHints[0] || "",
    WINDOW_FLASH_NOTIFY_WORKSPACE_HINTS: workspaceHints.join("\n"),
    WINDOW_FLASH_NOTIFY_PRODUCT: vscode.env.appName || "Visual Studio Code",
    WINDOW_FLASH_NOTIFY_UNTIL_FOREGROUND: flashUntilForeground ? "1" : "0",
    WINDOW_FLASH_NOTIFY_COUNT: String(flashCount),
    WINDOW_FLASH_NOTIFY_USE_PROCESS_CHAIN: useProcessChainTieBreaker ? "1" : "0"
  };
}

function getSoundPowerShell(): string {
  return `
$ErrorActionPreference = 'Stop'
$type = $env:WINDOW_FLASH_NOTIFY_TYPE
$customSoundPath = $env:WINDOW_FLASH_NOTIFY_SOUND_PATH

function Play-WindowFlashSystemSound([string]$notificationType) {
  if ($notificationType -eq 'error') {
    [System.Media.SystemSounds]::Hand.Play()
  } elseif ($notificationType -eq 'warning') {
    [System.Media.SystemSounds]::Exclamation.Play()
  } else {
    [System.Media.SystemSounds]::Asterisk.Play()
  }

  Start-Sleep -Milliseconds 700
}

if (-not [string]::IsNullOrWhiteSpace($customSoundPath) -and (Test-Path -LiteralPath $customSoundPath -PathType Leaf)) {
  try {
    $player = [System.Media.SoundPlayer]::new($customSoundPath)
    $player.Load()
    $player.PlaySync()
    exit 0
  } catch {
  }
}

Play-WindowFlashSystemSound $type
`;
}

function getToastPowerShell(): string {
  return `
$ErrorActionPreference = 'Stop'

$title = $env:WINDOW_FLASH_NOTIFY_TOAST_TITLE
$message = $env:WINDOW_FLASH_NOTIFY_TOAST_MESSAGE
$focusUri = $env:WINDOW_FLASH_NOTIFY_TOAST_FOCUS_URI
$actionContent = $env:WINDOW_FLASH_NOTIFY_TOAST_ACTION
$appId = $env:WINDOW_FLASH_NOTIFY_PRODUCT
if ([string]::IsNullOrWhiteSpace($actionContent)) {
  $actionContent = 'Focus VS Code'
}
if ([string]::IsNullOrWhiteSpace($appId)) {
  $appId = 'Visual Studio Code'
}

try {
  $startApps = @(Get-StartApps | Where-Object {
    $_.Name -like '*Visual Studio Code*' -or
    $_.Name -like '*VS Code*' -or
    $_.AppID -like '*VisualStudioCode*' -or
    $_.AppID -like '*Code*'
  } | Select-Object -First 10 Name, AppID)
  if ($startApps.Count -gt 0) {
    $preferredStartApp = @($startApps | Where-Object { $_.AppID -like '*VisualStudioCode*' } | Select-Object -First 1)
    if ($preferredStartApp.Count -eq 0) {
      $preferredStartApp = @($startApps | Select-Object -First 1)
    }
    if ($preferredStartApp.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace([string]$preferredStartApp[0].AppID)) {
      $appId = [string]$preferredStartApp[0].AppID
    }
  }
} catch {
}

$timeoutSeconds = 15
if ($env:WINDOW_FLASH_NOTIFY_TOAST_TIMEOUT) {
  [void][int]::TryParse($env:WINDOW_FLASH_NOTIFY_TOAST_TIMEOUT, [ref]$timeoutSeconds)
}
$timeoutSeconds = [Math]::Max(0, [Math]::Min(300, $timeoutSeconds))

function Escape-Xml([string]$value) {
  return [System.Security.SecurityElement]::Escape($value)
}

$escapedTitle = Escape-Xml $title
$escapedMessage = Escape-Xml $message
$escapedFocusUri = Escape-Xml $focusUri
$escapedActionContent = Escape-Xml $actionContent

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
    <action content="$escapedActionContent" arguments="$escapedFocusUri" activationType="protocol" />
  </actions>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
if ($timeoutSeconds -gt 0) {
  $toast.ExpirationTime = [System.DateTimeOffset]::Now.AddSeconds($timeoutSeconds)
}
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$notifier.Show($toast)
`;
}

function getFocusProtocolPowerShell(): string {
  return `
param([string]$windowFlashNotifyUri)
$ErrorActionPreference = 'Stop'

function ConvertFrom-WindowFlashNotifyQueryValue([string]$value) {
  if ($null -eq $value) {
    return ''
  }
  return [System.Uri]::UnescapeDataString(($value -replace '\\+', ' '))
}

if ([string]::IsNullOrWhiteSpace($windowFlashNotifyUri)) {
  exit 1
}

$parsedUri = [System.Uri]$windowFlashNotifyUri
$workspaceName = ''
$targetPid = '0'
$workspaceHints = New-Object System.Collections.Generic.List[string]
$query = $parsedUri.Query
if (-not [string]::IsNullOrWhiteSpace($query)) {
  foreach ($part in ($query.TrimStart('?') -split '&')) {
    if ([string]::IsNullOrWhiteSpace($part)) {
      continue
    }

    $pair = $part -split '=', 2
    $key = ConvertFrom-WindowFlashNotifyQueryValue $pair[0]
    $value = ''
    if ($pair.Count -gt 1) {
      $value = ConvertFrom-WindowFlashNotifyQueryValue $pair[1]
    }

    if ($key -eq 'workspaceName') {
      $workspaceName = $value
    } elseif ($key -eq 'targetPid') {
      $targetPid = $value
    } elseif ($key -eq 'workspaceHint') {
      [void]$workspaceHints.Add($value)
    }
  }
}

$env:WINDOW_FLASH_NOTIFY_TARGET_PID = $targetPid
$env:WINDOW_FLASH_NOTIFY_WORKSPACE = $workspaceName
$env:WINDOW_FLASH_NOTIFY_WORKSPACE_HINTS = [string]::Join([string][char]10, @($workspaceHints))
$env:WINDOW_FLASH_NOTIFY_PRODUCT = 'Visual Studio Code'

${getWindowLookupPowerShell()}

$selection = Select-WindowFlashTargets
foreach ($target in @($selection.Targets)) {
  $hwnd = [System.IntPtr]::new([int64]$target.Hwnd)
  $showCommand = Get-WindowFlashShowCommand $hwnd $true
  for ($attempt = 0; $attempt -lt 8; $attempt++) {
    if (Invoke-WindowFlashFocus $hwnd $showCommand) {
      break
    }
    Start-Sleep -Milliseconds 100
  }
}
`;
}

function getFocusProtocolVbs(powerShellPath: string, powerShellScriptPath: string): string {
  return `
Option Explicit

Dim uri
If WScript.Arguments.Count = 0 Then
  WScript.Quit 1
End If
uri = WScript.Arguments(0)

Dim shell
Set shell = CreateObject("WScript.Shell")

Dim command
command = Quote("${escapeVbsString(powerShellPath)}") _
  & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " _
  & Quote("${escapeVbsString(powerShellScriptPath)}") _
  & " " & Quote(uri)

shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
`;
}

function getWindowLookupPowerShell(): string {
  return `
$ErrorActionPreference = 'Stop'
$workspace = $env:WINDOW_FLASH_NOTIFY_WORKSPACE
$workspaceHintsRaw = $env:WINDOW_FLASH_NOTIFY_WORKSPACE_HINTS
$product = $env:WINDOW_FLASH_NOTIFY_PRODUCT
$useProcessChainTieBreaker = $env:WINDOW_FLASH_NOTIFY_USE_PROCESS_CHAIN -eq '1'
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

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public Int32 X;
    public Int32 Y;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public Int32 Left;
    public Int32 Top;
    public Int32 Right;
    public Int32 Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct WINDOWPLACEMENT {
    public Int32 length;
    public Int32 flags;
    public Int32 showCmd;
    public POINT ptMinPosition;
    public POINT ptMaxPosition;
    public RECT rcNormalPosition;
  }

  [DllImport("user32.dll")]
  public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

  [DllImport("user32.dll")]
  public static extern bool IsZoomed(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@

function Get-WindowFlashShowCommand([IntPtr]$hwnd, [bool]$maximizeIfMinimized) {
  $placement = New-Object WindowFlashNotifyUser32+WINDOWPLACEMENT
  $placement.length = [System.Runtime.InteropServices.Marshal]::SizeOf($placement)

  if ([WindowFlashNotifyUser32]::GetWindowPlacement($hwnd, [ref]$placement)) {
    if ($placement.showCmd -eq 3 -or (($placement.flags -band 2) -ne 0)) {
      return 3
    }
  }

  if ([WindowFlashNotifyUser32]::IsZoomed($hwnd)) {
    return 3
  }

  if ($maximizeIfMinimized -and [WindowFlashNotifyUser32]::IsIconic($hwnd)) {
    return 3
  }

  return 9
}

function Invoke-WindowFlashFocus([IntPtr]$hwnd, [int]$showCommand) {
  [void][WindowFlashNotifyUser32]::ShowWindowAsync($hwnd, $showCommand)
  [void][WindowFlashNotifyUser32]::SetForegroundWindow($hwnd)
  [WindowFlashNotifyUser32]::SwitchToThisWindow($hwnd, $true)

  if ($showCommand -eq 3) {
    [void][WindowFlashNotifyUser32]::ShowWindowAsync($hwnd, 3)
    [void][WindowFlashNotifyUser32]::SetForegroundWindow($hwnd)
  }

  return [WindowFlashNotifyUser32]::GetForegroundWindow().Equals($hwnd)
}

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

function Get-WindowFlashWorkspaceScore([string]$title) {
  $bestScore = 0
  $hintIndex = 0
  foreach ($hint in $workspaceHints) {
    if ($title.IndexOf($hint, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $score = 1000 + ($hint.Length * 10) - $hintIndex
      if ($hint -match '\\[[^\\]]+\\]') {
        $score = 50000 + ($hint.Length * 10) - $hintIndex
      } elseif ($hint -match '[\\\\/:]') {
        $score = 20000 + ($hint.Length * 10) - $hintIndex
      }

      if ($score -gt $bestScore) {
        $bestScore = $score
      }
    }
    $hintIndex += 1
  }
  return $bestScore
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
    $workspaceMatchScore = Get-WindowFlashWorkspaceScore $title
    $workspaceMatch = $workspaceMatchScore -gt 0
    $score = Get-WindowFlashChainScore -candidateChainIds $chainIds -targetChainIds $targetChainIds

    [void]$windows.Add([pscustomobject]@{
      Hwnd = $hWnd.ToInt64()
      Title = $title
      ProcessId = [int]$windowProcessId
      ProcessName = $processName
      ProcessMatchScore = $score
      WorkspaceMatch = $workspaceMatch
      WorkspaceMatchScore = $workspaceMatchScore
      Chain = @($chain)
    })

    return $true
  }

  [void][WindowFlashNotifyUser32]::EnumWindows($callback, [IntPtr]::Zero)
  return $windows.ToArray()
}

function Get-WindowFlashBasicCodeWindows {
  $windows = New-Object System.Collections.Generic.List[object]

  $callback = [WindowFlashNotifyUser32+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)

    if (-not [WindowFlashNotifyUser32]::IsWindowVisible($hWnd)) {
      return $true
    }

    $builder = New-Object System.Text.StringBuilder 1024
    [void][WindowFlashNotifyUser32]::GetWindowText($hWnd, $builder, $builder.Capacity)
    $title = $builder.ToString()
    if ([string]::IsNullOrWhiteSpace($title) -or -not (Test-WindowFlashCodeTitle $title)) {
      return $true
    }

    [uint32]$windowProcessId = 0
    [void][WindowFlashNotifyUser32]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)

    $processName = ''
    try {
      $processName = [string](Get-Process -Id ([int]$windowProcessId) -ErrorAction Stop).ProcessName
    } catch {
      return $true
    }

    if ($processName -notlike 'Code*' -and $processName -notlike 'VSCodium*') {
      return $true
    }

    $workspaceMatchScore = Get-WindowFlashWorkspaceScore $title
    [void]$windows.Add([pscustomobject]@{
      Hwnd = $hWnd.ToInt64()
      Title = $title
      ProcessId = [int]$windowProcessId
      ProcessName = $processName
      ProcessMatchScore = 0
      WorkspaceMatch = $workspaceMatchScore -gt 0
      WorkspaceMatchScore = $workspaceMatchScore
      Chain = @()
    })

    return $true
  }

  [void][WindowFlashNotifyUser32]::EnumWindows($callback, [IntPtr]::Zero)
  return $windows.ToArray()
}

function Add-WindowFlashProcessScores([object[]]$candidateWindows) {
  if (-not $useProcessChainTieBreaker -or $null -eq $candidateWindows -or $candidateWindows.Count -eq 0) {
    return @($candidateWindows)
  }

  $targetChainIds = @(Get-WindowFlashProcessChainIds $targetProcessId)
  foreach ($window in @($candidateWindows)) {
    $chain = @(Get-WindowFlashProcessChain ([int]$window.ProcessId))
    $chainIds = @($chain | ForEach-Object { [int]$_.ProcessId })
    $score = Get-WindowFlashChainScore -candidateChainIds $chainIds -targetChainIds $targetChainIds
    $window | Add-Member -NotePropertyName ProcessMatchScore -NotePropertyValue $score -Force
    $window | Add-Member -NotePropertyName Chain -NotePropertyValue @($chain) -Force
  }

  return @($candidateWindows)
}

function Resolve-WindowFlashProcessTieBreak([object[]]$matches, [object[]]$windows, [string]$source, [string]$reason) {
  if (-not $useProcessChainTieBreaker) {
    return $null
  }

  $scoredMatches = @(Add-WindowFlashProcessScores $matches)
  $processTieBreaks = @($scoredMatches | Where-Object { [int]$_.ProcessMatchScore -gt 0 } | Sort-Object -Property ProcessMatchScore -Descending)
  if ($processTieBreaks.Count -eq 0) {
    return $null
  }

  $bestProcessScore = [int]$processTieBreaks[0].ProcessMatchScore
  $bestProcessMatches = @($processTieBreaks | Where-Object { [int]$_.ProcessMatchScore -eq $bestProcessScore })
  if ($bestProcessMatches.Count -ne 1) {
    return $null
  }

  return [pscustomobject]@{
    Source = $source
    Targets = @($bestProcessMatches)
    Windows = @($windows)
    Reason = "$reason Process-chain tie-break selected score $bestProcessScore."
  }
}

function Select-WindowFlashTargets {
  $windows = @(Get-WindowFlashBasicCodeWindows)
  if ($windows.Count -eq 0) {
    throw "No visible VS Code window was found"
  }

  if ($workspaceHints.Count -gt 0) {
    $hintMatches = @($windows | Where-Object { [int]$_.WorkspaceMatchScore -gt 0 } | Sort-Object -Property WorkspaceMatchScore -Descending)
    if ($hintMatches.Count -gt 0) {
      $bestHintScore = [int]$hintMatches[0].WorkspaceMatchScore
      $bestHintMatches = @($hintMatches | Where-Object { [int]$_.WorkspaceMatchScore -eq $bestHintScore })
      $hintKind = if ($bestHintScore -ge 50000) { 'strongTitleHint' } elseif ($bestHintScore -ge 20000) { 'pathTitleHint' } else { 'titleHint' }
      if ($bestHintMatches.Count -eq 1) {
        return [pscustomobject]@{
          Source = $hintKind
          Targets = @($bestHintMatches)
          Windows = @($windows)
          Reason = "Unique title hint match with score $bestHintScore."
        }
      }

      $processTieBreakSource = "$($hintKind)ProcessTieBreak"
      $tieBreak = Resolve-WindowFlashProcessTieBreak -matches $bestHintMatches -windows $windows -source $processTieBreakSource -reason "Title hint match was tied at score $bestHintScore."
      if ($null -ne $tieBreak) {
        return $tieBreak
      }
    }
  }

  if ($windows.Count -eq 1 -and $workspaceHints.Count -eq 0) {
    return [pscustomobject]@{
      Source = 'singleVisibleWindowFallback'
      Targets = @($windows)
      Windows = @($windows)
      Reason = 'Only one visible VS Code window was available.'
    }
  }

  $titleText = [string]::Join('; ', @($windows | ForEach-Object { $_.Title }))
  $hintText = [string]::Join(', ', $workspaceHints)
  if ($workspaceHints.Count -gt 0) {
    throw "Window title hints did not uniquely identify a VS Code window. Process-chain tie-breaker enabled: $useProcessChainTieBreaker. Hints: $hintText. Visible VS Code title(s): $titleText"
  }

  throw "No window title hints were available and multiple VS Code windows are visible. Visible VS Code title(s): $titleText"
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
    $showCommand = Get-WindowFlashShowCommand $hwnd $false
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
      if (Invoke-WindowFlashFocus $hwnd $showCommand) {
        break
      }
      Start-Sleep -Milliseconds 120
    }
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
        WorkspaceMatchScore = $_.WorkspaceMatchScore
      }
    })
  }
}

$targetProcessChain = @()
$processWindows = @()
if ($useProcessChainTieBreaker) {
  $targetProcessChain = @(Get-WindowFlashProcessChain $targetProcessId)
  $processWindows = @(Get-WindowFlashCodeWindows)
}

$result = [pscustomobject]@{
  TargetProcessId = $targetProcessId
  ProcessChainTieBreakerEnabled = $useProcessChainTieBreaker
  TargetProcessChain = $targetProcessChain
  WorkspaceHints = @($workspaceHints)
  Selection = $selectionSummary
  SelectionError = $selectionError
  Windows = @(Get-WindowFlashBasicCodeWindows)
  ProcessWindows = $processWindows
}

$result | ConvertTo-Json -Depth 8
`;
}

async function runPowerShell(script: string, env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<void> {
  await runPowerShellWithOutput(script, env, timeoutMs);
}

function runHiddenProcess(command: string, args: string[], timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: "ignore"
    });

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
      finish(() => reject(new Error(`${command} timed out`)));
    }, timeoutMs);

    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("exit", (code) => {
      finish(() => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} exited with code ${String(code)}`));
        }
      });
    });
  });
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
      killPowerShellProcessTree(child.pid);
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

function killPowerShellProcessTree(pid: number | undefined): void {
  if (!pid || process.platform !== "win32") {
    return;
  }

  const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore"
  });
  killer.unref();
}

function schedulePowerShellDetached(name: string, script: string, env: NodeJS.ProcessEnv): void {
  setTimeout(() => {
    try {
      spawnPowerShellDetached(name, script, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Failed to launch ${name}: ${message}`);
    }
  }, 50);
}

function spawnPowerShellDetached(name: string, script: string, env: NodeJS.ProcessEnv): void {
  const scriptPath = writeDetachedPowerShellScript(name, script);
  const powerShellPath = getWindowsPowerShellPath();
  const child = spawn(powerShellPath, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-Command",
    getDetachedPowerShellBootstrap()
  ], {
    env: {
      ...env,
      WINDOW_FLASH_NOTIFY_SCRIPT_PATH: scriptPath
    },
    windowsHide: true,
    stdio: "ignore"
  });
  const killTimer = setTimeout(() => {
    killPowerShellProcessTree(child.pid);
    child.kill();
  }, 10000);
  child.once("error", (error) => {
    clearTimeout(killTimer);
    output.appendLine(`Detached PowerShell ${name} failed: ${error.message}`);
  });
  child.once("exit", () => {
    clearTimeout(killTimer);
  });
  child.unref();
}

function getWindowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function getWindowsWScriptPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return join(systemRoot, "System32", "wscript.exe");
}

function writeDetachedPowerShellScript(name: string, script: string): string {
  const dir = join(tmpdir(), "vscode-window-flash-notify");
  mkdirSync(dir, { recursive: true });
  const safeName = name.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  const scriptPath = join(dir, `${safeName}.ps1`);
  writeFileSync(scriptPath, script, "utf8");
  return scriptPath;
}

function getDetachedPowerShellBootstrap(): string {
  return `
$ErrorActionPreference = 'Stop'
$windowFlashNotifyScriptPath = $env:WINDOW_FLASH_NOTIFY_SCRIPT_PATH
if ([string]::IsNullOrWhiteSpace($windowFlashNotifyScriptPath)) {
  throw 'WINDOW_FLASH_NOTIFY_SCRIPT_PATH is empty'
}
if (-not (Test-Path -LiteralPath $windowFlashNotifyScriptPath)) {
  throw "Script file does not exist: $windowFlashNotifyScriptPath"
}
& $windowFlashNotifyScriptPath
`;
}

function getWorkspaceMatchHints(
  workspaceName?: string,
  workspacePath?: string,
  providedHints: string[] = []
): string[] {
  const includeCurrentWorkspace = !workspaceName && !workspacePath && providedHints.length === 0;
  return buildWorkspaceMatchHints(workspaceName, workspacePath, providedHints, includeCurrentWorkspace);
}

function getWorkspaceMatchHintsFromUri(
  workspaceName?: string,
  providedHints: string[] = []
): string[] {
  return buildWorkspaceMatchHints(workspaceName, undefined, providedHints, false);
}

function buildWorkspaceMatchHints(
  workspaceName: string | undefined,
  workspacePath: string | undefined,
  providedHints: string[],
  includeCurrentWorkspace: boolean
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
  addHint(workspacePath);
  addHint(basenameFromAnyPath(workspacePath));

  if (includeCurrentWorkspace) {
    addNameVariants(getWorkspaceName());

    for (const folder of vscode.workspace.workspaceFolders || []) {
      addNameVariants(folder.name);
      addHint(folder.uri.fsPath);
      addHint(folder.uri.path);
      addHint(basenameFromAnyPath(folder.uri.fsPath));
      addHint(basenameFromAnyPath(folder.uri.path));
    }
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

function getExtensionVersion(context: vscode.ExtensionContext): string {
  return getPackageVersionFromPath(context.extensionUri.fsPath) ?? getPackageJsonVersion(context.extension.packageJSON);
}

function getPackageVersionFromPath(extensionPath: string | undefined): string | undefined {
  if (!extensionPath) {
    return undefined;
  }

  try {
    const packageJson = JSON.parse(readFileSync(join(extensionPath, "package.json"), "utf8")) as unknown;
    const version = getPackageJsonVersion(packageJson);
    return version === "unknown" ? undefined : version;
  } catch {
    return undefined;
  }
}

function getPackageJsonVersion(packageJson: unknown): string {
  if (
    packageJson &&
    typeof packageJson === "object" &&
    "version" in packageJson &&
    typeof packageJson.version === "string"
  ) {
    return packageJson.version;
  }

  return "unknown";
}

function escapeVbsString(value: string): string {
  return value.replace(/"/g, "\"\"");
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) {
      return 1;
    }
    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}

function parseVersion(version: string): number[] {
  return version
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function readOptionalNotifyType(value: unknown): NotifyType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "info" || value === "warning" || value === "error") {
    return value;
  }
  throw new Error(`Invalid notification type: ${String(value)}`);
}

function readOptionalNotifyAction(value: unknown): NotifyAction | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "flash" || value === "focus" || value === "none") {
    return value;
  }
  throw new Error(`Invalid action: ${String(value)}`);
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
