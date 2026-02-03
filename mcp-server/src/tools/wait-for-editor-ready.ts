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
  let pollInterval = 500;
  const maxPollInterval = 2000;

  // Check if already connected
  if (existingConnection?.isConnected) {
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

  // Find project root
  const projectRoot = projectPath || findProjectRoot();
  if (!projectRoot) {
    return {
      result: {
        status: "error",
        message: "Unity project not found (no Library folder)",
      },
    };
  }

  let lastError = "";

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Check if MCPInstance.json exists
      const instancePath = path.join(projectRoot, "Library", "MCPInstance.json");
      if (!fs.existsSync(instancePath)) {
        lastError = "MCPInstance.json not found - Unity MCP plugin may be reloading";
        await sleep(pollInterval);
        pollInterval = Math.min(Math.floor(pollInterval * 1.5), maxPollInterval);
        continue;
      }

      // Read instance info
      const mcpInstance = readMCPInstance(projectRoot);
      if (!mcpInstance) {
        lastError = "Failed to read MCPInstance.json";
        await sleep(pollInterval);
        pollInterval = Math.min(Math.floor(pollInterval * 1.5), maxPollInterval);
        continue;
      }

      // Verify Unity process is running
      if (!isProcessRunning(mcpInstance.pid)) {
        lastError = "Unity process not running (stale MCPInstance.json)";
        await sleep(pollInterval);
        pollInterval = Math.min(Math.floor(pollInterval * 1.5), maxPollInterval);
        continue;
      }

      // Try to connect and ping
      const connection = new UnityConnection(mcpInstance.port);
      try {
        await connection.connect();
        const pingOk = await connection.ping();

        if (pingOk) {
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
          connection.disconnect();
        }
      } catch (e) {
        lastError = `Connection failed: ${e instanceof Error ? e.message : String(e)}`;
        connection.disconnect();
      }
    } catch (e) {
      lastError = `Error: ${e instanceof Error ? e.message : String(e)}`;
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
