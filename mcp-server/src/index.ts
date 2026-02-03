import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findUnityConnection, findProjectRoot } from "./unity-finder.js";
import { UnityConnection } from "./unity-connection.js";
import { readLogsSchema, readLogs } from "./tools/read-logs.js";
import { executeMenuSchema, executeMenu } from "./tools/execute-menu.js";

let unity: UnityConnection | null = null;

async function ensureConnection(): Promise<UnityConnection> {
  if (unity?.isConnected) {
    return unity;
  }

  const connectionInfo = findUnityConnection();
  if (!connectionInfo) {
    throw new Error(
      "Unity Editor not found. Make sure Unity is running with the MCP plugin loaded."
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
    "Read Unity Editor console logs. Returns recent log messages including errors, warnings, and info logs.",
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
    "Execute a Unity Editor menu item by its path. Use this to trigger Unity actions like saving scenes, refreshing assets, entering play mode, etc.",
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

  // Log startup info
  const projectRoot = findProjectRoot();
  console.error(`[MCP] Unity MCP Server starting...`);
  console.error(`[MCP] Project root: ${projectRoot || "not found"}`);

  // Start the server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[MCP] Unity MCP Server running");
}

main().catch((error) => {
  console.error(`[MCP] Fatal error: ${error.message}`);
  process.exit(1);
});
