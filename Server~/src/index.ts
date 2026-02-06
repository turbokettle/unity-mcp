#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  findUnityConnection,
  findProjectRoot,
  readMCPInstance,
  isProcessRunning,
} from "./unity-finder.js";
import { UnityConnection } from "./unity-connection.js";
import { DynamicToolManager } from "./dynamic-tools.js";
import { waitForEditorReady } from "./tools/wait-for-editor-ready.js";

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
let toolManager: DynamicToolManager | null = null;

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

        // Sync tools on successful connection
        if (toolManager) {
          await toolManager.syncTools(unity);
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
      { timeout_seconds: 60, wait_for_reload: false },
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

      // Sync tools on successful connection
      if (toolManager) {
        await toolManager.syncTools(unity);
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

  // Create the dynamic tool manager
  toolManager = new DynamicToolManager(server, {
    projectPath: explicitProjectPath,
    getConnection: () => unity,
    setConnection: (conn) => {
      unity = conn;
      setupConnectionHandlers(conn);
    },
    ensureConnection,
  });

  // Log startup info
  const projectRoot = explicitProjectPath || findProjectRoot();
  console.error(`[MCP] Unity MCP Server starting...`);
  console.error(`[MCP] Project root: ${projectRoot || "not found"}`);
  if (explicitProjectPath) {
    console.error(`[MCP] (using explicit --project path)`);
  }

  // Try to connect to Unity and sync tools at startup
  try {
    const conn = await ensureConnection();
    console.error(`[MCP] Connected to Unity, synced ${toolManager.getRegisteredTools().length} dynamic tools`);
  } catch (error) {
    console.error(`[MCP] Could not connect to Unity at startup: ${error instanceof Error ? error.message : error}`);
    console.error(`[MCP] Dynamic tools will be synced when Unity becomes available`);
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
