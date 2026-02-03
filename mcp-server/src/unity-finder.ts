import * as fs from "fs";
import * as path from "path";

export interface MCPInstanceInfo {
  port: number;
  pid: number;
  projectPath: string;
}

export interface EditorInstanceInfo {
  process_id: number;
  version: string;
}

/**
 * Check if a process with the given PID is running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the Unity project root by looking for Library folder.
 * Starts from current directory and walks up.
 */
export function findProjectRoot(startDir?: string): string | null {
  let dir = startDir || process.cwd();

  // Walk up to find Library folder
  while (dir !== path.dirname(dir)) {
    const libraryPath = path.join(dir, "Library");
    if (fs.existsSync(libraryPath) && fs.statSync(libraryPath).isDirectory()) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Read the MCP instance info from the Unity project's Library folder.
 */
export function readMCPInstance(projectRoot: string): MCPInstanceInfo | null {
  const instancePath = path.join(projectRoot, "Library", "MCPInstance.json");

  if (!fs.existsSync(instancePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(instancePath, "utf-8");
    const info = JSON.parse(content) as MCPInstanceInfo;

    // Validate required fields
    if (typeof info.port !== "number" || typeof info.pid !== "number") {
      console.error("[MCP] Invalid MCPInstance.json format");
      return null;
    }

    return info;
  } catch (e) {
    console.error(`[MCP] Failed to read MCPInstance.json: ${e}`);
    return null;
  }
}

/**
 * Read Unity's EditorInstance.json to validate the Unity process is running.
 */
export function readEditorInstance(
  projectRoot: string
): EditorInstanceInfo | null {
  const instancePath = path.join(projectRoot, "Library", "EditorInstance.json");

  if (!fs.existsSync(instancePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(instancePath, "utf-8");
    return JSON.parse(content) as EditorInstanceInfo;
  } catch (e) {
    console.error(`[MCP] Failed to read EditorInstance.json: ${e}`);
    return null;
  }
}

/**
 * Find Unity connection info for the project.
 * Returns null if Unity is not running or MCP server is not available.
 */
export function findUnityConnection(projectRoot?: string): {
  port: number;
  projectPath: string;
} | null {
  const root = projectRoot || findProjectRoot();

  if (!root) {
    console.error("[MCP] Unity project not found (no Library folder)");
    return null;
  }

  // Read MCP instance info
  const mcpInstance = readMCPInstance(root);
  if (!mcpInstance) {
    console.error("[MCP] MCPInstance.json not found - Unity MCP plugin may not be running");
    return null;
  }

  // Validate Unity process is still running
  const editorInstance = readEditorInstance(root);
  if (editorInstance) {
    if (!isProcessRunning(editorInstance.process_id)) {
      console.error("[MCP] Unity Editor process is not running (stale instance files)");
      return null;
    }
  }

  // Also check MCP process
  if (!isProcessRunning(mcpInstance.pid)) {
    console.error("[MCP] MCP server process is not running (stale MCPInstance.json)");
    return null;
  }

  return {
    port: mcpInstance.port,
    projectPath: mcpInstance.projectPath,
  };
}
