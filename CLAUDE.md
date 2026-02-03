# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This project enables Claude Code to interact with the Unity Editor via the Model Context Protocol (MCP). It consists of two components:

1. **Unity Editor Plugin** (`Assets/Editor/MCP/`) - C# scripts that run inside Unity and expose functionality via a local TCP server
2. **MCP Server** (`mcp-server/`) - TypeScript server that bridges Claude Code to Unity

## Development Environment

- **Unity**: 6000.0.65f1 (Unity 6 LTS)
- **Node.js**: Required for the MCP server
- **TypeScript**: 5.3+

## Build Commands

### MCP Server (in `mcp-server/` directory)
```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm run dev          # Watch mode compilation
npm start            # Run the server
```

### Unity
Open the project in Unity 6000.0.65f1. The Editor scripts compile automatically via `[InitializeOnLoad]`.

## Available MCP Tools

### read_console_logs
Read Unity Editor console logs with filtering.
- **count**: Number of entries to retrieve (1-1000, default 50)
- **filter**: "all" | "errors" | "warnings" (default "all")

### execute_menu_item
Execute Unity Editor menu items by path (e.g., "File/Save Scene", "Assets/Refresh").
- Automatically waits for domain reload when executing refresh-related menu items
- Handles reconnection after script recompilation

### wait_for_editor_ready
Wait for Unity Editor to become ready after domain reload (script recompilation).
- **timeout_seconds**: Maximum wait time (5-120 seconds, default 30)
- Use after modifying C# scripts to ensure Unity has finished reloading

## Architecture

### Unity Side (`Assets/Editor/MCP/`)
- `MCPBridge.cs` - Bootstrap and initialization; writes `Library/MCPInstance.json` for discovery
- `MCPServer.cs` - TCP server with background thread listener and main thread command queue
- `Protocol.cs` - JSON message serialization (MCPRequest/MCPResponse format)
- `WindowWaker.cs` - Win32 interop to keep Unity responsive when minimized
- `Commands/GetLogsCommand.cs` - Captures console logs via circular buffer (max 1000 entries)
- `Commands/ExecMenuCommand.cs` - Executes menu items via `EditorApplication.ExecuteMenuItem`

### MCP Server Side (`mcp-server/src/`)
- `index.ts` - MCP server entry point with tool definitions
- `unity-connection.ts` - TCP client with persistent connection and auto-reconnection
- `unity-finder.ts` - Locates Unity instances via `Library/MCPInstance.json`
- `tools/` - Individual tool implementations

## Communication Protocol

### Connection Discovery
1. MCP server walks up from cwd looking for Unity project (Library folder)
2. Reads `Library/MCPInstance.json` containing port, PID, and project path
3. Validates Unity process is running via PID check
4. Connects to dynamic TCP port specified in instance file

### Message Format
**Request**: `{ id, cmd, params }` where cmd is "ping" | "get_logs" | "exec_menu"
**Response**: `{ id, ok, data, error }`

### Threading Model
- **Background threads**: TCP listener and per-client message handlers
- **Main thread**: Command execution via `EditorApplication.update` queue
- Thread-safe: ConcurrentQueue, locks on NetworkStream writes and log buffer

### Domain Reload Handling
When Unity recompiles scripts, the TCP server restarts. The MCP server:
1. Detects connection loss or refresh menu execution
2. Polls for new `MCPInstance.json` with exponential backoff (500ms → 2000ms)
3. Validates PID and reconnects automatically
