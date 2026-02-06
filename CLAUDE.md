# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This project enables Claude Code to interact with the Unity Editor via the Model Context Protocol (MCP). It consists of two components distributed separately:

1. **Unity Editor Plugin** (`Editor/`) - C# UPM package that runs inside Unity, exposing functionality via a local TCP server
2. **MCP Server** (`Server~/`) - TypeScript npm package that bridges Claude Code to Unity

## Package Distribution

- **UPM (Unity)**: `https://github.com/turbokettle/unity-mcp.git`
- **npm (Claude Code)**: `npx -y @turbokettle/unity-mcp`

## Development Environment

- **Unity**: 6000.0+ (Unity 6)
- **Node.js**: Required for the MCP server
- **TypeScript**: 5.3+

## Build Commands

### MCP Server (in `Server~/` directory)
```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm run dev          # Watch mode compilation
npm start            # Run the server
```

### Unity
Add the package to a Unity project. The Editor scripts compile automatically via `[InitializeOnLoad]`.

## Project Structure

```
unity-mcp/
├── package.json          # UPM package manifest (com.turbokettle.unity-mcp)
├── Editor/               # Unity Editor scripts (asmdef: com.turbokettle.unity-mcp.editor)
│   ├── MCPBridge.cs      # Bootstrap, writes Library/MCPInstance.json
│   ├── MCPServer.cs      # TCP server with main thread queue
│   ├── Protocol.cs       # JSON message serialization
│   ├── WindowWaker.cs    # Win32 interop for minimized Unity
│   ├── IMcpTool.cs       # Tool interface for auto-discovery
│   ├── ToolSchema.cs     # [ToolParameter] attribute and JSON Schema generation
│   ├── ToolRegistry.cs   # Reflection-based tool discovery
│   └── Tools/
│       ├── GetLogsTool.cs
│       ├── ExecMenuTool.cs
│       └── GetProjectInfoTool.cs
├── Server~/              # MCP server (hidden from Unity's asset importer)
│   ├── package.json      # npm package (@turbokettle/unity-mcp)
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts      # Entry point, stdio transport
│       ├── dynamic-tools.ts
│       ├── unity-connection.ts
│       ├── unity-finder.ts
│       └── tools/
│           └── wait-for-editor-ready.ts
├── README.md
├── CHANGELOG.md
└── LICENSE
```

## Adding New Tools

To add a new built-in MCP tool, create a class implementing `IMcpTool` in `Editor/Tools/`:

```csharp
using UnityMCP;

namespace UnityMCP.Tools
{
    [System.Serializable]
    public class MyToolParams
    {
        [ToolParameter("Description of param", Required = true)]
        public string myParam;
    }

    public class MyTool : IMcpTool
    {
        public string Name => "my_tool";
        public string Description => "What this tool does";
        public bool RequiresMainThread => false; // true if using Unity APIs

        public ToolParameterSchema GetParameterSchema()
            => SchemaBuilder.FromType<MyToolParams>();

        public MCPResponse Execute(string id, string paramsJson)
        {
            var prms = JsonUtility.FromJson<MyToolParams>(paramsJson);
            // ... implementation ...
            return MCPResponse.Success(id, result);
        }
    }
}
```

The tool will be automatically discovered on Unity domain reload and registered with the MCP server.

**Important**: Claude Code caches the tool list at session start. After adding a new tool:
1. Save the file and let Unity recompile
2. Restart Claude Code to pick up the new tool

**For user-created tools outside this package**: If your tools are in an assembly definition, add a reference to `com.turbokettle.unity-mcp.editor`. Tools in `Assets/Editor/` without an asmdef can reference package types automatically (via `autoReferenced`).

## Known Limitations

### Tool Discovery Requires Claude Restart
New tools added during a Claude Code session won't be visible until Claude is restarted. This is because Claude Code caches the MCP tool list at startup and doesn't refresh it mid-session, even when the MCP server signals that tools have changed.

### Domain Reload Disconnection
When Unity recompiles scripts, the TCP connection is briefly lost. The MCP server automatically waits for Unity to finish reloading when the next tool is invoked, so no manual intervention is needed.

## Communication Protocol

### Connection Discovery
1. MCP server walks up from cwd looking for Unity project (Library folder)
2. Reads `Library/MCPInstance.json` containing port, PID, and project path
3. Validates Unity process is running via PID check
4. Connects to dynamic TCP port specified in instance file

### Message Format
**Request**: `{ id, cmd, params }` where cmd is:
- `ping` - Connection validation
- `list_tools` - Get available tools with JSON schemas
- `invoke_tool` - Execute a tool (params: `{ tool, arguments }`)

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
