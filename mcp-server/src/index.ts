import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  findUnityConnection,
  findProjectRoot,
  readMCPInstance,
  isProcessRunning,
} from "./unity-finder.js";
import { UnityConnection } from "./unity-connection.js";
import { readLogsSchema, readLogs } from "./tools/read-logs.js";
import { executeMenuSchema, executeMenu } from "./tools/execute-menu.js";
import {
  waitForEditorReadySchema,
  waitForEditorReady,
} from "./tools/wait-for-editor-ready.js";

// Parse --project argument if provided, otherwise use cwd
function getProjectPath(): string | undefined {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  if (projectIdx !== -1 && args[projectIdx + 1]) {
    return args[projectIdx + 1];
  }
  return undefined; // Will use cwd
}

const explicitProjectPath = getProjectPath();

let unity: UnityConnection | null = null;
let lastKnownPid: number | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Menu items that trigger domain reload
const REFRESH_MENU_ITEMS = ["Assets/Refresh", "Assets/Reimport All"];

function setupConnectionHandlers(conn: UnityConnection): void {
  conn.on("close", () => {
    console.error("[MCP] Unity connection lost, will reconnect on next request");
    unity = null;
  });
  conn.on("error", (err) => {
    console.error(`[MCP] Unity connection error: ${err.message}`);
  });
}

async function ensureConnection(): Promise<UnityConnection> {
  // Try existing connection first
  if (unity?.isConnected) {
    try {
      if (await unity.ping()) {
        return unity;
      }
    } catch {
      // Connection stale, continue to reconnect
    }
    unity = null;
  }

  const projectRoot = explicitProjectPath || findProjectRoot();

  // Try quick connect (MCPInstance.json exists)
  const connectionInfo = findUnityConnection(projectRoot || undefined);

  if (connectionInfo) {
    // Normal path: MCPInstance.json exists
    unity = new UnityConnection(connectionInfo.port);
    setupConnectionHandlers(unity);

    try {
      await unity.connect();
      if (await unity.ping()) {
        // Cache PID on successful connection
        const mcpInstance = readMCPInstance(projectRoot!);
        if (mcpInstance) {
          lastKnownPid = mcpInstance.pid;
        }
        return unity;
      }
    } catch {
      unity.disconnect();
      unity = null;
    }
  }

  // MCPInstance.json missing or connection failed - check if Unity is reloading
  if (lastKnownPid && isProcessRunning(lastKnownPid)) {
    // Unity process alive but MCP server not ready → wait for reload
    console.error("[MCP] Unity process alive, waiting for domain reload to complete...");
    const { result, connection } = await waitForEditorReady(
      { timeout_seconds: 60 },
      projectRoot || undefined,
      null
    );

    if (result.status === "ready" && connection) {
      unity = connection;
      setupConnectionHandlers(unity);
      // Update cached PID
      const mcpInstance = readMCPInstance(projectRoot!);
      if (mcpInstance) {
        lastKnownPid = mcpInstance.pid;
      }
      return unity;
    }

    throw new Error(
      `Unity is reloading but didn't recover: ${result.lastError || result.message}`
    );
  }

  // No cached PID or process dead → fail fast
  throw new Error(
    "Unity Editor not found. Make sure Unity is running with the MCP plugin loaded." +
      (projectRoot ? ` (looking in: ${projectRoot})` : "")
  );
}

async function main() {
  const server = new McpServer({
    name: "unity-mcp",
    version: "1.0.0",
  });

  // Register read_console_logs tool
  server.tool(
    "read_console_logs",
    "Read Unity Editor console logs.",
    readLogsSchema.shape,
    async (params) => {
      try {
        const conn = await ensureConnection();
        const parsed = readLogsSchema.parse(params);
        const result = await readLogs(conn, parsed);
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Register execute_menu_item tool
  server.tool(
    "execute_menu_item",
    "Execute a Unity Editor menu item by its path. Use this to trigger Unity actions like saving scenes, refreshing assets, etc.",
    executeMenuSchema.shape,
    async (params) => {
      try {
        const conn = await ensureConnection();
        const parsed = executeMenuSchema.parse(params);
        const result = await executeMenu(conn, parsed);

        // If this menu item triggers refresh, wait for Unity to be ready
        const triggersRefresh = REFRESH_MENU_ITEMS.some(
          (item) => parsed.path.toLowerCase() === item.toLowerCase()
        );

        if (triggersRefresh) {
          // Small delay to ensure domain reload has started
          await sleep(500);

          const projectRoot = explicitProjectPath || findProjectRoot();
          const { result: waitResult, connection } = await waitForEditorReady(
            { timeout_seconds: 60 },
            projectRoot || undefined,
            unity
          );

          // Update connection if we got a new one
          if (connection && waitResult.status === "ready") {
            if (unity && unity !== connection) {
              unity.disconnect();
            }
            unity = connection;
            setupConnectionHandlers(unity);
          }

          if (waitResult.status !== "ready") {
            return {
              content: [
                {
                  type: "text",
                  text: `${result}\n\nWarning: Unity may still be reloading (${waitResult.lastError || waitResult.message}).`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `${result}\n\nUnity reloaded and ready (waited ${waitResult.waitTimeMs}ms).`,
              },
            ],
          };
        }

        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Register wait_for_editor_ready tool
  server.tool(
    "wait_for_editor_ready",
    "Wait for Unity Editor to become ready after domain reload (script recompilation or asset refresh). Use this after modifying scripts or assets to ensure Unity has finished reloading before executing other commands.",
    waitForEditorReadySchema.shape,
    async (params) => {
      try {
        const parsed = waitForEditorReadySchema.parse(params);
        const projectRoot = explicitProjectPath || findProjectRoot() || undefined;
        const { result, connection } = await waitForEditorReady(
          parsed,
          projectRoot,
          unity
        );

        // Update global connection if we got a new one
        if (connection && result.status === "ready" && !result.wasAlreadyConnected) {
          if (unity && unity !== connection) {
            unity.disconnect();
          }
          unity = connection;
          setupConnectionHandlers(unity);
        }

        if (result.status === "ready") {
          const lines = [
            `Unity Editor is ready.`,
            `Was already connected: ${result.wasAlreadyConnected}`,
            `Wait time: ${result.waitTimeMs}ms`,
          ];
          if (result.port) lines.push(`Port: ${result.port}`);

          return {
            content: [{ type: "text", text: lines.join("\n") }],
          };
        } else if (result.status === "timeout") {
          return {
            content: [
              {
                type: "text",
                text: `Timeout waiting for Unity Editor (${result.waitTimeMs}ms).\nLast error: ${result.lastError}`,
              },
            ],
            isError: true,
          };
        } else {
          return {
            content: [{ type: "text", text: `Error: ${result.message}` }],
            isError: true,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Log startup info
  const projectRoot = explicitProjectPath || findProjectRoot();
  console.error(`[MCP] Unity MCP Server starting...`);
  console.error(`[MCP] Project root: ${projectRoot || "not found"}`);
  if (explicitProjectPath) {
    console.error(`[MCP] (using explicit --project path)`);
  }

  // Start the server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[MCP] Unity MCP Server running");
}

main().catch((error) => {
  console.error(`[MCP] Fatal error: ${error.message}`);
  process.exit(1);
});
