import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { UnityConnection } from "./unity-connection.js";
import { waitForEditorReady } from "./tools/wait-for-editor-ready.js";
import { findProjectRoot } from "./unity-finder.js";

interface ToolInfo {
  name: string;
  description: string;
  requiresMainThread: boolean;
  parameterSchema: string; // JSON Schema as string
}

interface ToolListResponse {
  version: number;
  tools: ToolInfo[];
}

interface JsonSchemaProperty {
  type: string;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
}

interface JsonSchema {
  type: string;
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

// Menu items that trigger domain reload
const REFRESH_MENU_ITEMS = ["Assets/Refresh", "Assets/Reimport All"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Manages dynamic tool registration from Unity.
 * Fetches tool definitions from Unity's ToolRegistry and registers them with the MCP server.
 */
export class DynamicToolManager {
  private server: McpServer;
  private registeredTools = new Set<string>();
  private lastKnownVersion = 0;
  private projectPath: string | undefined;
  private getConnection: () => UnityConnection | null;
  private setConnection: (conn: UnityConnection) => void;

  constructor(
    server: McpServer,
    options: {
      projectPath?: string;
      getConnection: () => UnityConnection | null;
      setConnection: (conn: UnityConnection) => void;
    }
  ) {
    this.server = server;
    this.projectPath = options.projectPath;
    this.getConnection = options.getConnection;
    this.setConnection = options.setConnection;
  }

  /**
   * Sync tools from Unity. Fetches the tool list and registers any new/updated tools.
   */
  async syncTools(unity: UnityConnection): Promise<void> {
    const response = await unity.send("list_tools");

    if (!response.ok || !response.data) {
      throw new Error(response.error || "Failed to list tools from Unity");
    }

    const toolList = JSON.parse(response.data) as ToolListResponse;

    if (toolList.version === this.lastKnownVersion && this.registeredTools.size > 0) {
      console.error(`[MCP] Tool list unchanged (version ${toolList.version})`);
      return;
    }

    console.error(`[MCP] Syncing ${toolList.tools.length} tools from Unity (version ${toolList.version})`);

    for (const tool of toolList.tools) {
      if (!this.registeredTools.has(tool.name)) {
        this.registerTool(tool, unity);
      }
    }

    this.lastKnownVersion = toolList.version;

    // Signal tool list changed if MCP SDK supports it
    try {
      this.server.sendToolListChanged?.();
    } catch {
      // sendToolListChanged may not be available in all versions
    }
  }

  /**
   * Register a single tool with the MCP server.
   */
  private registerTool(tool: ToolInfo, unity: UnityConnection): void {
    const zodSchema = this.buildZodSchema(tool.parameterSchema);

    this.server.tool(
      tool.name,
      tool.description,
      zodSchema,
      async (params) => {
        return this.invokeUnityTool(tool.name, params, unity);
      }
    );

    this.registeredTools.add(tool.name);
    console.error(`[MCP] Registered tool: ${tool.name}`);
  }

  /**
   * Build a Zod schema from JSON Schema.
   */
  private buildZodSchema(schemaJson: string): Record<string, z.ZodTypeAny> {
    let schema: JsonSchema;
    try {
      schema = JSON.parse(schemaJson) as JsonSchema;
    } catch {
      console.error(`[MCP] Failed to parse schema JSON: ${schemaJson}`);
      return {};
    }

    const zodShape: Record<string, z.ZodTypeAny> = {};

    for (const [key, prop] of Object.entries(schema.properties || {})) {
      let zodType: z.ZodTypeAny;

      switch (prop.type) {
        case "integer":
          zodType = z.number().int();
          if (prop.minimum !== undefined) zodType = (zodType as z.ZodNumber).min(prop.minimum);
          if (prop.maximum !== undefined) zodType = (zodType as z.ZodNumber).max(prop.maximum);
          break;

        case "number":
          zodType = z.number();
          if (prop.minimum !== undefined) zodType = (zodType as z.ZodNumber).min(prop.minimum);
          if (prop.maximum !== undefined) zodType = (zodType as z.ZodNumber).max(prop.maximum);
          break;

        case "boolean":
          zodType = z.boolean();
          break;

        case "string":
          if (prop.enum && prop.enum.length > 0) {
            // Create enum schema
            zodType = z.enum(prop.enum as [string, ...string[]]);
          } else {
            zodType = z.string();
          }
          break;

        case "array":
          zodType = z.array(z.unknown());
          break;

        default:
          zodType = z.unknown();
      }

      // Add description
      if (prop.description) {
        zodType = zodType.describe(prop.description);
      }

      // Make optional with default if not required
      const isRequired = schema.required?.includes(key) ?? false;
      if (!isRequired) {
        if (prop.default !== undefined) {
          zodType = zodType.optional().default(prop.default as never);
        } else {
          zodType = zodType.optional();
        }
      }

      zodShape[key] = zodType;
    }

    return zodShape;
  }

  /**
   * Invoke a tool on Unity and format the response.
   */
  private async invokeUnityTool(
    toolName: string,
    params: Record<string, unknown>,
    unity: UnityConnection
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    try {
      const response = await unity.send("invoke_tool", {
        tool: toolName,
        arguments: JSON.stringify(params),
      });

      if (!response.ok) {
        return {
          content: [{ type: "text", text: `Error: ${response.error || "Unknown error"}` }],
          isError: true,
        };
      }

      // Format the response data
      let text: string;
      if (response.data) {
        try {
          const data = JSON.parse(response.data);
          text = this.formatToolResult(toolName, data);
        } catch {
          text = response.data;
        }
      } else {
        text = `Tool ${toolName} executed successfully.`;
      }

      // Handle refresh menu items that trigger domain reload
      if (toolName === "execute_menu_item" && params.path) {
        const triggersRefresh = REFRESH_MENU_ITEMS.some(
          (item) => (params.path as string).toLowerCase() === item.toLowerCase()
        );

        if (triggersRefresh) {
          // Small delay to ensure domain reload has started
          await sleep(500);

          const projectRoot = this.projectPath || findProjectRoot() || undefined;
          const currentConnection = this.getConnection();
          const { result: waitResult, connection } = await waitForEditorReady(
            { timeout_seconds: 60 },
            projectRoot,
            currentConnection
          );

          // Update connection if we got a new one
          if (connection && waitResult.status === "ready") {
            if (currentConnection && currentConnection !== connection) {
              currentConnection.disconnect();
            }
            this.setConnection(connection);
          }

          if (waitResult.status !== "ready") {
            return {
              content: [
                {
                  type: "text",
                  text: `${text}\n\nWarning: Unity may still be reloading (${waitResult.lastError || waitResult.message}).`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `${text}\n\nUnity reloaded and ready (waited ${waitResult.waitTimeMs}ms).`,
              },
            ],
          };
        }
      }

      return {
        content: [{ type: "text", text }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  /**
   * Format tool result data into a human-readable string.
   */
  private formatToolResult(toolName: string, data: unknown): string {
    // Handle known tool response formats
    if (toolName === "read_console_logs") {
      return this.formatLogsResult(data);
    }

    if (toolName === "execute_menu_item") {
      return this.formatMenuResult(data);
    }

    // Default: pretty-print JSON
    return JSON.stringify(data, null, 2);
  }

  private formatLogsResult(data: unknown): string {
    const logsData = data as { logs?: Array<{ timestamp: string; type: string; message: string; stackTrace?: string }> };

    if (!logsData.logs || logsData.logs.length === 0) {
      return "No logs available.";
    }

    const formatted = logsData.logs.map((entry) => {
      const icon =
        entry.type === "Error" || entry.type === "Exception"
          ? "[ERROR]"
          : entry.type === "Warning"
            ? "[WARN]"
            : "[LOG]";

      let text = `${entry.timestamp} ${icon} ${entry.message}`;

      if (entry.stackTrace && (entry.type === "Error" || entry.type === "Exception")) {
        text += `\n  Stack trace:\n  ${entry.stackTrace.replace(/\n/g, "\n  ")}`;
      }

      return text;
    });

    return `Unity Console Logs (${logsData.logs.length} entries):\n\n${formatted.join("\n\n")}`;
  }

  private formatMenuResult(data: unknown): string {
    const menuData = data as { success?: boolean; message?: string };

    if (menuData.message) {
      if (!menuData.success) {
        throw new Error(menuData.message);
      }
      return menuData.message;
    }

    return menuData.success ? "Menu item executed successfully." : "Menu item execution failed.";
  }

  /**
   * Get the list of registered tool names.
   */
  getRegisteredTools(): string[] {
    return Array.from(this.registeredTools);
  }

  /**
   * Check if tools have been synced.
   */
  hasSyncedTools(): boolean {
    return this.registeredTools.size > 0;
  }
}
