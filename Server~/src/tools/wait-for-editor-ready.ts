import { z } from "zod";
import { findProjectRoot, readMCPInstance } from "../unity-finder.js";
import { UnityConnection } from "../unity-connection.js";
import * as fs from "fs";
import * as path from "path";

export const waitForEditorReadySchema = z.object({
  timeout_seconds: z
    .number()
    .int()
    .min(15)
    .max(300)
    .optional()
    .default(60)
    .describe("Maximum time to wait for Unity to become ready (15-300 seconds)"),
  wait_for_reload: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Set to true if you just triggered a script recompilation or asset refresh. " +
        "This ensures the tool waits for the actual reload instead of returning immediately if Unity is still responding."
    ),
});

export type WaitForEditorReadyInput = z.infer<typeof waitForEditorReadySchema>;

export interface WaitResult {
  status: "ready" | "timeout" | "error";
  wasAlreadyConnected?: boolean;
  waitTimeMs?: number;
  port?: number;
  lastError?: string;
  message?: string;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForEditorReady(
  input: WaitForEditorReadyInput,
  projectPath: string | undefined,
  existingConnection: UnityConnection | null
): Promise<{ result: WaitResult; connection?: UnityConnection }> {
  const startTime = Date.now();
  const timeoutMs = input.timeout_seconds * 1000;
  const expectingReload = input.wait_for_reload;
  let pollInterval = 500;
  const maxPollInterval = 2000;

  // If expecting a reload (e.g., after Assets/Refresh), don't trust the existing connection
  // We need to wait for Unity to actually reload and get a fresh connection
  if (!expectingReload && existingConnection?.isConnected) {
    try {
      const pingOk = await existingConnection.ping();
      if (pingOk) {
        return {
          result: {
            status: "ready",
            wasAlreadyConnected: true,
            waitTimeMs: 0,
          },
          connection: existingConnection,
        };
      }
    } catch {
      // Connection is stale, continue with polling
    }
  }

  // Find project root first (needed to read MCPInstance.json for previous port)
  const projectRoot = projectPath || findProjectRoot();

  // If expecting reload, read current port from MCPInstance.json and disconnect
  let previousPort: number | undefined;
  if (expectingReload) {
    // Read current port before reload
    if (projectRoot) {
      const mcpInstance = readMCPInstance(projectRoot);
      if (mcpInstance) {
        previousPort = mcpInstance.port;
      }
    }
    // Disconnect existing connection
    if (existingConnection) {
      existingConnection.disconnect();
    }
  }
  if (!projectRoot) {
    return {
      result: {
        status: "error",
        message: "Unity project not found (no Library folder)",
      },
    };
  }

  let lastError = "";
  let sawDisconnect = !expectingReload; // If not expecting reload, we don't need to wait for disconnect

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Check if MCPInstance.json exists
      const instancePath = path.join(projectRoot, "Library", "MCPInstance.json");
      if (!fs.existsSync(instancePath)) {
        lastError = "MCPInstance.json not found - Unity MCP plugin may be reloading";
        sawDisconnect = true; // MCPInstance.json missing means reload is happening
        await sleep(pollInterval);
        pollInterval = Math.min(Math.floor(pollInterval * 1.5), maxPollInterval);
        continue;
      }

      // Read instance info
      const mcpInstance = readMCPInstance(projectRoot);
      if (!mcpInstance) {
        lastError = "Failed to read MCPInstance.json";
        sawDisconnect = true;
        await sleep(pollInterval);
        pollInterval = Math.min(Math.floor(pollInterval * 1.5), maxPollInterval);
        continue;
      }

      // Verify Unity process is running
      if (!isProcessRunning(mcpInstance.pid)) {
        lastError = "Unity process not running (stale MCPInstance.json)";
        sawDisconnect = true;
        await sleep(pollInterval);
        pollInterval = Math.min(Math.floor(pollInterval * 1.5), maxPollInterval);
        continue;
      }

      // If expecting reload and haven't seen disconnect yet, check if port changed
      if (expectingReload && !sawDisconnect && previousPort !== undefined) {
        if (mcpInstance.port !== previousPort) {
          sawDisconnect = true; // Port changed, reload happened
        }
      }

      // Try to connect and ping
      const connection = new UnityConnection(mcpInstance.port);
      try {
        await connection.connect();
        const pingOk = await connection.ping();

        if (pingOk) {
          // If expecting reload but haven't seen disconnect, this might be the old server
          if (expectingReload && !sawDisconnect) {
            lastError = "Waiting for Unity to start reloading...";
            connection.disconnect();
            await sleep(pollInterval);
            pollInterval = Math.min(Math.floor(pollInterval * 1.5), maxPollInterval);
            continue;
          }

          return {
            result: {
              status: "ready",
              wasAlreadyConnected: false,
              waitTimeMs: Date.now() - startTime,
              port: mcpInstance.port,
            },
            connection,
          };
        } else {
          lastError = "Ping failed - Unity not responding";
          sawDisconnect = true;
          connection.disconnect();
        }
      } catch (e) {
        lastError = `Connection failed: ${e instanceof Error ? e.message : String(e)}`;
        sawDisconnect = true; // Connection failure means reload is in progress
        connection.disconnect();
      }
    } catch (e) {
      lastError = `Error: ${e instanceof Error ? e.message : String(e)}`;
      sawDisconnect = true;
    }

    await sleep(pollInterval);
    pollInterval = Math.min(Math.floor(pollInterval * 1.5), maxPollInterval);
  }

  return {
    result: {
      status: "timeout",
      waitTimeMs: Date.now() - startTime,
      lastError,
    },
  };
}
