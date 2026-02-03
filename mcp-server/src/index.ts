import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findUnityConnection, findProjectRoot } from "./unity-finder.js";
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

async function ensureConnection(): Promise<UnityConnection> {
  if (unity?.isConnected) {
    return unity;
  }

  const projectRoot = explicitProjectPath || findProjectRoot();
  const connectionInfo = findUnityConnection(projectRoot || undefined);
  if (!connectionInfo) {
    throw new Error(
      "Unity Editor not found. Make sure Unity is running with the MCP plugin loaded." +
      (projectRoot ? ` (looking in: ${projectRoot})` : "")
    );
  }

  unity = new UnityConnection(connectionInfo.port);

  unity.on("close", () => {
    console.error("[MCP] Unity connection lost, will reconnect on next request");
    unity = null;
  });

  unity.on("error", (err) => {
    console.error(`[MCP] Unity connection error: ${err.message}`);
  });

  await unity.connect();

  // Verify connection with ping
  const pingOk = await unity.ping();
  if (!pingOk) {
    unity.disconnect();
    unity = null;
    throw new Error("Failed to verify connection to Unity (ping failed)");
  }

  return unity;
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

          unity.on("close", () => {
            console.error("[MCP] Unity connection lost, will reconnect on next request");
            unity = null;
          });
          unity.on("error", (err) => {
            console.error(`[MCP] Unity connection error: ${err.message}`);
          });
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
