# Unity MCP

Model Context Protocol (MCP) bridge for Unity Editor — enables AI tools like [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to interact with the Unity Editor.

> **Work in progress** — this project is under active development and the API may change between versions. Expect rough edges.

## Why another Unity MCP?

The goal of this project is a **minimal, focused API** that helps with real work instead of throwing 100 MCP tools at the context window and hoping that the LLM figures it out. This is designed for low context usage with sharp, and precise tools for a human-in-the-loop workflow.

## How It Works

This project has two components:

1. **Unity Plugin** — C# scripts that run inside the Unity Editor, exposing functionality via a local TCP server
2. **MCP Server** — Node.js server that bridges Claude Code (or any MCP client) to the Unity plugin

The plugin auto-starts when Unity opens, and the MCP server connects to it to relay tool calls.

## Installation

### 1. Unity Package

Open your Unity project (Unity 6+), then:

**Window > Package Manager > + > Add package from git URL:**

```
https://github.com/turbokettle/unity-mcp.git
```

### 2. MCP Server

Add to your project's `.mcp.json` (or Claude Code settings):

```json
{
  "mcpServers": {
    "unity": {
      "command": "npx",
      "args": ["-y", "@turbokettle/unity-mcp"]
    }
  }
}
```

Or install globally:

```bash
npm install -g @turbokettle/unity-mcp
```

Then in `.mcp.json`:

```json
{
  "mcpServers": {
    "unity": {
      "command": "unity-mcp"
    }
  }
}
```

The MCP server auto-discovers your Unity project by walking up from the current working directory looking for a `Library/` folder. You can also pass `--project /path/to/unity/project` explicitly.

## Available Tools

| Tool | Description |
|------|-------------|
| `read_console_logs` | Read Unity console logs with filtering (all/errors/warnings) |
| `execute_menu_item` | Execute Unity menu items by path (e.g., "File/Save Scene") |
| `get_project_info` | Get project name, Unity version, scene info, play mode state |
| `wait_for_editor_ready` | Wait for Unity to finish domain reload after script changes |

## Adding Custom Tools

Create a class implementing `IMcpTool` in your Unity project:

```csharp
using UnityMCP;

namespace MyProject
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
        public bool RequiresMainThread => true;

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

Tools are auto-discovered on domain reload. **Note:** Claude Code caches the tool list at startup, so restart Claude Code after adding new tools.

If your custom tools are in an assembly definition, add a reference to `com.turbokettle.unity-mcp.editor`.

## Troubleshooting

**"Not connected to Unity" errors**
Unity briefly disconnects during domain reload (script recompilation). The server auto-reconnects. Use `wait_for_editor_ready` after triggering recompilation.

**New tools not appearing**
Claude Code caches the MCP tool list at startup. Restart Claude Code after adding new tools to Unity.

**Server can't find Unity**
Make sure Unity is running with the project open. The server looks for `Library/MCPInstance.json` in your project. If running from a different directory, use `--project /path/to/project`.

## License

MIT
