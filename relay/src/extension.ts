import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
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

interface PendingAck {
  token: string;
  timeout: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const uiNotifyCommand = "windowFlashNotify.notify";
const uiHealthCommand = "windowFlashNotify.health";
const uiExtensionId = "qqqasdwx.vscode-window-flash-notify";
const endpointEnvVar = "WINDOW_FLASH_NOTIFY_ENDPOINT";
const uiCommandTimeoutMs = 3000;
const uriAckTimeoutMs = 5000;
const output = vscode.window.createOutputChannel("Window Flash Notify Relay");

let server: http.Server | undefined;
let activePort: number | undefined;
let activeEndpoint: string | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let extensionVersion = "unknown";
const pendingAcks = new Map<string, PendingAck>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  extensionVersion = getExtensionVersion(context);
  output.appendLine("Activating Window Flash Notify Relay");

  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.commands.registerCommand("windowFlashNotifyRelay.copyCurlCommand", async () => {
      await vscode.env.clipboard.writeText(buildCurlCommand());
      vscode.window.showInformationMessage("Window Flash Notify relay curl command copied.");
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("windowFlashNotifyRelay.testFlash", async () => {
      await forwardToUi({
        message: "Relay test notification",
        type: "info",
        action: "flash"
      });
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
  activeEndpoint = `http://${listenHost}:${port}/notify`;
  updateTerminalEnvironment(activeEndpoint);
  output.appendLine(`Listening on http://${listenHost}:${port}`);
}

async function stopServer(): Promise<void> {
  const runningServer = server;
  server = undefined;

  if (runningServer) {
    await new Promise<void>((resolve) => runningServer.close(() => resolve()));
  }

  for (const [requestId, pending] of pendingAcks) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(`Relay stopped before URI ack arrived: ${requestId}`));
  }
  pendingAcks.clear();

  extensionContext?.environmentVariableCollection.delete(endpointEnvVar);
  activePort = undefined;
  activeEndpoint = undefined;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    if (req.method === "GET" && req.url?.startsWith("/health")) {
      sendJson(res, 200, {
        ok: true,
        role: "relay",
        version: extensionVersion,
        relayVersion: extensionVersion,
        port: activePort,
        endpoint: activeEndpoint,
        endpointEnvVar,
        workspaceName: getWorkspaceName(),
        workspacePath: getPrimaryWorkspacePath(),
        workspaceHints: getWorkspaceMatchHints(),
        uiExtension: getExtensionInfo(uiExtensionId),
        uiHealth: await getUiHealth(),
        uiCommand: uiNotifyCommand,
        uiHealthCommand,
        uiCommandTimeoutMs,
        uriAckTimeoutMs
      });
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/ack")) {
      await handleAckRequest(req, res);
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
    const result = await forwardToUi(payload);
    sendJson(res, 200, { success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Request failed: ${message}`);
    sendJson(res, 400, { error: message });
  }
}

async function forwardToUi(payload: NotifyPayload): Promise<unknown> {
  const enriched = enrichPayload(payload);
  output.appendLine(
    `Forward: action=${enriched.action || "flash"} workspace=${enriched.workspaceName || ""} hints=${enriched.workspaceHints?.join("|") || ""}`
  );

  try {
    const result = await withTimeout(
      vscode.commands.executeCommand(uiNotifyCommand, enriched),
      uiCommandTimeoutMs,
      `UI command ${uiNotifyCommand} timed out after ${uiCommandTimeoutMs}ms`
    );
    return stripNotifyVersion(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isUiCommandTimeoutError(error)) {
      output.appendLine(`${message}; dispatching URI fallback`);
      return dispatchToUiViaUri(enriched, message);
    }

    throw new Error(
      `Failed to call UI command ${uiNotifyCommand}. Install and enable qqqasdwx.vscode-window-flash-notify locally. ${message}`
    );
  }
}

async function getUiHealth(): Promise<unknown> {
  try {
    return {
      ...asRecordOrValue(await withTimeout(
        vscode.commands.executeCommand(uiHealthCommand),
        uiCommandTimeoutMs,
        `UI command ${uiHealthCommand} timed out after ${uiCommandTimeoutMs}ms`
      )),
      dispatch: "command"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`UI health command failed: ${message}; dispatching URI fallback`);
    return dispatchUiHealthViaUri(message);
  }
}

async function dispatchUiHealthViaUri(commandError: string): Promise<unknown> {
  if (!activePort) {
    return {
      ok: false,
      role: "ui",
      version: "unknown",
      dispatch: "uri",
      error: `Relay port is unavailable for UI health URI fallback. ${commandError}`
    };
  }

  const relayRequestId = randomUUID();
  const relayCallbackToken = randomUUID();
  const relayCallbackUri = await buildRelayAckExternalUri(relayRequestId);
  const waiter = createPendingAck(relayRequestId, relayCallbackToken, uriAckTimeoutMs);
  const uri = buildUiHealthUri(relayRequestId, relayCallbackUri, relayCallbackToken);

  let opened = false;
  try {
    opened = await vscode.env.openExternal(uri);
  } catch (error) {
    waiter.cancel();
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      role: "ui",
      version: "unknown",
      dispatch: "uri",
      uiHealthCommandError: commandError,
      error: message
    };
  }

  if (!opened) {
    waiter.cancel();
    return {
      ok: false,
      role: "ui",
      version: "unknown",
      dispatch: "uri",
      uiHealthCommandError: commandError,
      error: "UI health URI fallback could not be opened"
    };
  }

  try {
    return {
      ...asRecordOrValue(await waiter.promise),
      dispatch: "uri",
      uiHealthCommandError: commandError,
      uriAckReceived: true,
      uriAckTimeoutMs
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      role: "ui",
      version: "unknown",
      dispatch: "uri",
      uiHealthCommandError: commandError,
      uriAckReceived: false,
      uriAckTimeoutMs,
      error: message
    };
  }
}

async function handleAckRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readRequestBody(req);
  const parsed = raw.trim() ? JSON.parse(raw) as unknown : {};
  if (!isRecord(parsed)) {
    sendJson(res, 400, { error: "Ack body must be an object" });
    return;
  }

  const requestId = typeof parsed.requestId === "string" ? parsed.requestId : "";
  const token = typeof parsed.token === "string" ? parsed.token : "";
  if (!requestId || !token) {
    sendJson(res, 400, { error: "Ack requestId and token are required" });
    return;
  }

  const pending = pendingAcks.get(requestId);
  if (!pending) {
    sendJson(res, 404, { error: "Ack request was not pending" });
    return;
  }

  if (pending.token !== token) {
    sendJson(res, 401, { error: "Invalid ack token" });
    return;
  }

  pending.resolve(parsed.result);
  sendJson(res, 200, { success: true });
}

async function dispatchToUiViaUri(payload: NotifyPayload, commandError: string): Promise<unknown> {
  const uri = buildUiNotifyUri(payload);
  let opened = false;
  try {
    opened = await vscode.env.openExternal(uri);
  } catch (error) {
    throw error;
  }
  if (!opened) {
    throw new Error(`UI command timed out and URI fallback could not be opened. ${commandError}`);
  }

  return {
    ...buildUriFallbackNotifyResult(payload),
    dispatch: "uri",
    uiCommandTimedOut: true,
    uiCommandTimeoutMs,
    uiCommandError: commandError
  };
}

async function buildRelayAckExternalUri(requestId: string): Promise<string> {
  if (!activePort) {
    throw new Error("Relay port is unavailable");
  }

  const callbackUri = vscode.Uri.parse(`http://127.0.0.1:${activePort}/ack?requestId=${encodeURIComponent(requestId)}`);
  return (await vscode.env.asExternalUri(callbackUri)).toString(true);
}

function createPendingAck(
  requestId: string,
  token: string,
  timeoutMs: number
): { promise: Promise<unknown>; cancel: () => void } {
  let settled = false;
  const promise = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      pendingAcks.delete(requestId);
      reject(new Error(`URI ack timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingAcks.set(requestId, {
      token,
      timeout,
      resolve: (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        pendingAcks.delete(requestId);
        resolve(value);
      },
      reject: (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        pendingAcks.delete(requestId);
        reject(error);
      }
    });
  });

  return {
    promise,
    cancel: () => {
      const pending = pendingAcks.get(requestId);
      if (!pending) {
        return;
      }
      pending.reject(new Error(`URI ack was cancelled: ${requestId}`));
    }
  };
}

function buildUriFallbackNotifyResult(payload: NotifyPayload): Record<string, unknown> {
  return {
    success: true,
    action: payload.action || "flash",
    workspaceName: payload.workspaceName || getWorkspaceName(),
    workspaceHints: payload.workspaceHints || [],
    platform: process.platform,
    implementation: "uri-fallback-after-ui-command-timeout"
  };
}

function buildUiNotifyUri(payload: NotifyPayload): vscode.Uri {
  const params = new URLSearchParams();
  params.set("payload", Buffer.from(JSON.stringify(payload), "utf8").toString("base64"));
  return vscode.Uri.from({
    scheme: vscode.env.uriScheme,
    authority: uiExtensionId,
    path: "/notify",
    query: params.toString()
  });
}

function buildUiHealthUri(
  relayRequestId: string,
  relayCallbackUri: string,
  relayCallbackToken: string
): vscode.Uri {
  const params = new URLSearchParams();
  params.set("relayRequestId", relayRequestId);
  params.set("relayCallbackUri", relayCallbackUri);
  params.set("relayCallbackToken", relayCallbackToken);
  return vscode.Uri.from({
    scheme: vscode.env.uriScheme,
    authority: uiExtensionId,
    path: "/health",
    query: params.toString()
  });
}

function withTimeout<T>(promise: Thenable<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      const error = new Error(message) as Error & { code: string };
      error.code = "UI_COMMAND_TIMEOUT";
      reject(error);
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function isUiCommandTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: string }).code === "UI_COMMAND_TIMEOUT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecordOrValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value };
}

function stripNotifyVersion(result: unknown): unknown {
  if (!isRecord(result) || !("version" in result)) {
    return result;
  }

  const { version: _version, ...rest } = result;
  return rest;
}

function enrichPayload(payload: NotifyPayload): NotifyPayload {
  const workspaceName = payload.workspaceName || getWorkspaceName();
  const workspacePath = payload.workspacePath || getPrimaryWorkspacePath();
  return {
    ...payload,
    workspaceName,
    workspacePath,
    workspaceHints: getWorkspaceMatchHints(workspaceName, workspacePath, payload.workspaceHints)
  };
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

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.title !== undefined && typeof parsed.title !== "string") {
    throw new Error("title must be a string");
  }
  if (parsed.message !== undefined && typeof parsed.message !== "string") {
    throw new Error("message must be a string");
  }
  if (
    parsed.type !== undefined &&
    (typeof parsed.type !== "string" || !["info", "warning", "error"].includes(parsed.type))
  ) {
    throw new Error(`Invalid notification type: ${String(parsed.type)}`);
  }
  if (
    parsed.action !== undefined &&
    (typeof parsed.action !== "string" || !["flash", "focus", "none"].includes(parsed.action))
  ) {
    throw new Error(`Invalid action: ${String(parsed.action)}`);
  }
  if (parsed.workspaceName !== undefined && typeof parsed.workspaceName !== "string") {
    throw new Error("workspaceName must be a string");
  }
  if (parsed.workspacePath !== undefined && typeof parsed.workspacePath !== "string") {
    throw new Error("workspacePath must be a string");
  }
  if (parsed.workspaceHints !== undefined && !Array.isArray(parsed.workspaceHints)) {
    throw new Error("workspaceHints must be an array of strings");
  }
  if (
    Array.isArray(parsed.workspaceHints) &&
    parsed.workspaceHints.some((hint) => typeof hint !== "string")
  ) {
    throw new Error("workspaceHints must be an array of strings");
  }
  if (parsed.showInternalNotification !== undefined && typeof parsed.showInternalNotification !== "boolean") {
    throw new Error("showInternalNotification must be a boolean");
  }
  if (parsed.sound !== undefined && typeof parsed.sound !== "boolean") {
    throw new Error("sound must be a boolean");
  }
  if (parsed.showToast !== undefined && typeof parsed.showToast !== "boolean") {
    throw new Error("showToast must be a boolean");
  }
  if (parsed.toastTimeout !== undefined && (
    typeof parsed.toastTimeout !== "number" ||
    !Number.isFinite(parsed.toastTimeout) ||
    parsed.toastTimeout < 0
  )) {
    throw new Error("toastTimeout must be zero or a positive number");
  }
  return parsed as NotifyPayload;
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

function updateTerminalEnvironment(endpoint: string): void {
  if (!extensionContext) {
    return;
  }

  const collection = extensionContext.environmentVariableCollection;
  collection.persistent = false;
  collection.description = "Window Flash Notify Relay endpoint";
  collection.replace(endpointEnvVar, endpoint, {
    applyAtProcessCreation: true,
    applyAtShellIntegration: true
  });
  output.appendLine(`Set terminal environment: ${endpointEnvVar}=${endpoint}`);
}

function buildCurlCommand(): string {
  const endpoint = activeEndpoint || "http://127.0.0.1:7531/notify";
  const token = getConfig().get<string>("authToken", "");
  const tokenHeader = token ? ` \\\n  -H 'X-Window-Flash-Token: ${shellSingleQuote(token)}'` : "";
  const body = JSON.stringify({
    message: "Window Flash Notify relay test",
    type: "info",
    action: "flash",
    showToast: true,
    sound: true,
    workspaceName: getWorkspaceName(),
    workspacePath: getPrimaryWorkspacePath()
  });

  return `curl -fsS -X POST '${endpoint}' \\\n  -H 'Content-Type: application/json'${tokenHeader} \\\n  --data '${shellSingleQuote(body)}'`;
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

function getPrimaryWorkspacePath(): string {
  const firstFolder = vscode.workspace.workspaceFolders?.[0];
  return firstFolder?.uri.fsPath || firstFolder?.uri.path || "";
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("windowFlashNotifyRelay");
}

function getExtensionInfo(
  id: string
): { id: string; version: string; isActive: boolean; extensionKind: vscode.ExtensionKind | "unknown" } {
  const extension = vscode.extensions.getExtension(id);
  return {
    id,
    version: extension
      ? getPackageVersionFromPath(extension.extensionUri.fsPath) ?? getPackageJsonVersion(extension.packageJSON)
      : "not-found",
    isActive: extension?.isActive ?? false,
    extensionKind: extension?.extensionKind ?? "unknown"
  };
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

function shellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\"'\"'");
}
