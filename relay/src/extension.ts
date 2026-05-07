import * as http from "node:http";
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

const uiNotifyCommand = "windowFlashNotify.notify";
const endpointEnvVar = "WINDOW_FLASH_NOTIFY_ENDPOINT";
const output = vscode.window.createOutputChannel("Window Flash Notify Relay");

let server: http.Server | undefined;
let activePort: number | undefined;
let activeEndpoint: string | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
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
        port: activePort,
        endpoint: activeEndpoint,
        endpointEnvVar,
        workspaceName: getWorkspaceName(),
        workspacePath: getPrimaryWorkspacePath(),
        workspaceHints: getWorkspaceMatchHints(),
        uiCommand: uiNotifyCommand
      });
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
    return await vscode.commands.executeCommand(uiNotifyCommand, enriched);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to call UI command ${uiNotifyCommand}. Install and enable qqqasdwx.vscode-window-flash-notify locally. ${message}`
    );
  }
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

  const parsed = JSON.parse(raw) as NotifyPayload;
  if (parsed.type && !["info", "warning", "error"].includes(parsed.type)) {
    throw new Error(`Invalid notification type: ${parsed.type}`);
  }
  if (parsed.action && !["flash", "focus", "none"].includes(parsed.action)) {
    throw new Error(`Invalid action: ${parsed.action}`);
  }
  if (parsed.workspaceHints && !Array.isArray(parsed.workspaceHints)) {
    throw new Error("workspaceHints must be an array of strings");
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

function shellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\"'\"'");
}
