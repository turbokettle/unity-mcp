# Complete MCP Server Reference Guide (February 2026)

The Model Context Protocol (MCP) enables seamless integration between LLM applications and external data sources, tools, and prompts. This guide provides everything needed to build an MCP server from scratch, covering protocol specification, SDK implementation, and configuration for Claude Desktop and Claude Code. **The current protocol version is 2025-11-25**, with MCP now governed by the Agentic AI Foundation under the Linux Foundation.

---

## Protocol specification fundamentals

MCP uses **JSON-RPC 2.0** over various transports for all communication. It's a stateful protocol requiring proper lifecycle management between clients and servers.

### JSON-RPC message format

**Request structure:**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-request-id",
  "method": "tools/call",
  "params": {
    "name": "calculator",
    "arguments": { "a": 5, "b": 3 }
  }
}
```

**Response (success):**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-request-id",
  "result": {
    "content": [{ "type": "text", "text": "Result: 8" }]
  }
}
```

**Error response:**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-request-id",
  "error": {
    "code": -32602,
    "message": "Invalid params",
    "data": { "details": "Missing required field" }
  }
}
```

**Notification (no response expected):**
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

### Standard error codes

| Code | Meaning |
|------|---------|
| `-32700` | Parse error (invalid JSON) |
| `-32600` | Invalid request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-32000` to `-32099` | Server/MCP-specific errors |

---

## Transport mechanisms

### stdio transport (recommended for local servers)

The client launches the MCP server as a subprocess. Messages are **newline-delimited JSON** on stdin/stdout.

- Server reads from `stdin`, writes to `stdout`
- Logging goes to `stderr` only—never write non-MCP content to stdout
- Shutdown: client closes stdin, then sends `SIGTERM`, then `SIGKILL` if needed

### Streamable HTTP transport (recommended for remote servers)

Introduced in spec version **2025-03-26**, this replaces the older HTTP+SSE transport. Uses a single endpoint supporting both POST and GET:

**Sending messages (client → server):**
```http
POST /mcp HTTP/1.1
Content-Type: application/json
Accept: application/json, text/event-stream
Mcp-Session-Id: session-abc123
MCP-Protocol-Version: 2025-11-25

{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
```

**Response options:**
- `Content-Type: application/json` for single JSON responses
- `Content-Type: text/event-stream` for SSE streaming
- `202 Accepted` for notifications (no body)

**Session management:** Server returns `Mcp-Session-Id` header during initialization; client includes it in all subsequent requests.

**Security requirements:** Servers must validate `Origin` header, bind localhost servers to `127.0.0.1` only, and implement authentication for remote deployments.

---

## Protocol lifecycle

### Initialization handshake

**1. Client sends `initialize` request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "capabilities": {
      "roots": { "listChanged": true },
      "sampling": {}
    },
    "clientInfo": { "name": "MyClient", "version": "1.0.0" }
  }
}
```

**2. Server responds with capabilities:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-11-25",
    "capabilities": {
      "tools": { "listChanged": true },
      "resources": { "subscribe": true, "listChanged": true },
      "prompts": { "listChanged": true },
      "logging": {}
    },
    "serverInfo": { "name": "MyServer", "version": "1.0.0" },
    "instructions": "Optional usage instructions"
  }
}
```

**3. Client sends `initialized` notification:**
```json
{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

### Server capabilities reference

| Capability | Description |
|------------|-------------|
| `tools` | Exposes callable tools |
| `tools.listChanged` | Notifies when tool list changes |
| `resources` | Provides readable resources |
| `resources.subscribe` | Supports resource subscriptions |
| `resources.listChanged` | Notifies when resource list changes |
| `prompts` | Offers prompt templates |
| `prompts.listChanged` | Notifies when prompt list changes |
| `logging` | Emits structured log messages |
| `completions` | Supports argument autocompletion |

---

## Core primitives

### Tools (model-controlled actions)

Tools are executable functions the LLM can invoke automatically. They have an `inputSchema` for parameters and return content results.

**Tool definition:**
```json
{
  "name": "get_weather",
  "title": "Weather Lookup",
  "description": "Get current weather for a location",
  "inputSchema": {
    "type": "object",
    "properties": {
      "location": { "type": "string", "description": "City name" }
    },
    "required": ["location"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "temperature": { "type": "number" },
      "conditions": { "type": "string" }
    }
  }
}
```

**Protocol methods:**
- `tools/list` → returns `{ tools: [...], nextCursor? }`
- `tools/call` with `{ name, arguments }` → returns `{ content: [...], isError?, structuredContent? }`

**Tool result content types:**
```json
// Text
{ "type": "text", "text": "Result text" }

// Image
{ "type": "image", "data": "base64...", "mimeType": "image/png" }

// Resource link
{ "type": "resource_link", "uri": "file:///path", "name": "file.txt" }

// Embedded resource
{ "type": "resource", "resource": { "uri": "...", "text": "..." } }
```

**Error handling:** Set `isError: true` to indicate tool execution failures (the LLM can see and respond to these):
```json
{
  "content": [{ "type": "text", "text": "API rate limit exceeded" }],
  "isError": true
}
```

### Resources (application-controlled data)

Resources expose read-only data sources like files, databases, or API responses. The host application decides how to incorporate them.

**Resource definition:**
```json
{
  "uri": "file:///project/config.json",
  "name": "config.json",
  "title": "Application Configuration",
  "description": "Main config file",
  "mimeType": "application/json"
}
```

**URI templates** allow dynamic resources:
```json
{
  "uriTemplate": "users://{userId}/profile",
  "name": "User Profile",
  "description": "Access user profiles by ID"
}
```

**Protocol methods:**
- `resources/list` → returns `{ resources: [...] }`
- `resources/templates/list` → returns `{ resourceTemplates: [...] }`
- `resources/read` with `{ uri }` → returns `{ contents: [{ uri, text?, blob?, mimeType? }] }`
- `resources/subscribe` / `resources/unsubscribe` for change notifications

### Prompts (user-controlled templates)

Prompts are reusable message templates that users explicitly select.

**Prompt definition:**
```json
{
  "name": "code_review",
  "title": "Code Review Request",
  "description": "Generate a code review prompt",
  "arguments": [
    { "name": "code", "description": "Code to review", "required": true },
    { "name": "language", "description": "Programming language", "required": false }
  ]
}
```

**Protocol methods:**
- `prompts/list` → returns `{ prompts: [...] }`
- `prompts/get` with `{ name, arguments }` → returns `{ messages: [...] }`

**PromptMessage structure:**
```json
{
  "role": "user",
  "content": { "type": "text", "text": "Please review this code..." }
}
```

### Sampling (server-initiated LLM requests)

Allows servers to request LLM completions from clients, enabling agentic behavior.

**Request:**
```json
{
  "method": "sampling/createMessage",
  "params": {
    "messages": [{ "role": "user", "content": { "type": "text", "text": "Summarize this" } }],
    "modelPreferences": {
      "hints": [{ "name": "claude-3-sonnet" }],
      "intelligencePriority": 0.8
    },
    "maxTokens": 500
  }
}
```

### Logging

Servers can emit structured log messages at various levels: `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`.

```json
{
  "method": "notifications/message",
  "params": {
    "level": "info",
    "logger": "database",
    "data": { "message": "Connection established", "host": "localhost" }
  }
}
```

---

## TypeScript SDK implementation

### Installation

```bash
npm install @modelcontextprotocol/sdk zod
# or
bun add @modelcontextprotocol/sdk zod
```

**Requirements:** Node.js 18+, Zod v3.25+ (peer dependency)

### Complete server example

**package.json:**
```json
{
  "name": "mcp-demo-server",
  "version": "1.0.0",
  "type": "module",
  "bin": { "mcp-demo": "dist/index.js" },
  "scripts": { "build": "tsc", "start": "node dist/index.js" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^2.0.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^22",
    "typescript": "^5.8"
  }
}
```

**src/index.ts:**
```typescript
#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "demo-mcp-server",
  version: "1.0.0"
});

// ============ TOOL ============
server.registerTool(
  "calculate",
  {
    title: "Calculator",
    description: "Perform arithmetic operations",
    inputSchema: {
      operation: z.enum(["add", "subtract", "multiply", "divide"]),
      a: z.number().describe("First operand"),
      b: z.number().describe("Second operand")
    }
  },
  async ({ operation, a, b }) => {
    let result: number;
    switch (operation) {
      case "add": result = a + b; break;
      case "subtract": result = a - b; break;
      case "multiply": result = a * b; break;
      case "divide":
        if (b === 0) {
          return {
            content: [{ type: "text", text: "Error: Division by zero" }],
            isError: true
          };
        }
        result = a / b;
        break;
    }
    return {
      content: [{ type: "text", text: `${a} ${operation} ${b} = ${result}` }]
    };
  }
);

// ============ RESOURCE ============
server.registerResource(
  "server-info",
  "info://server",
  {
    title: "Server Information",
    description: "Information about this MCP server",
    mimeType: "application/json"
  },
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify({
        name: "demo-mcp-server",
        version: "1.0.0",
        uptime: process.uptime()
      }, null, 2)
    }]
  })
);

// Dynamic resource with URI template
server.registerResource(
  "greeting",
  new ResourceTemplate("greeting://{name}", { list: undefined }),
  { title: "Personalized Greeting" },
  async (uri, { name }) => ({
    contents: [{ uri: uri.href, text: `Hello, ${name}!` }]
  })
);

// ============ PROMPT ============
server.registerPrompt(
  "code-review",
  {
    title: "Code Review",
    description: "Generate a code review prompt",
    argsSchema: {
      code: z.string().describe("Code to review"),
      language: z.string().optional().describe("Programming language")
    }
  },
  ({ code, language }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Review this ${language || "code"}:\n\n\`\`\`${language || ""}\n${code}\n\`\`\``
      }
    }]
  })
);

// ============ START SERVER ============
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Server running on stdio");
}

main().catch(console.error);
```

### Running the TypeScript server

```bash
# Build and run
npm run build && node dist/index.js

# Or with npx after publishing
npx mcp-demo

# Or directly with ts-node/bun
bunx --bun tsx src/index.ts
```

### HTTP transport setup

```typescript
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json());

const sessions: Record<string, StreamableHTTPServerTransport> = {};

app.all('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string;
  
  if (sessionId && sessions[sessionId]) {
    await sessions[sessionId].handleRequest(req, res, req.body);
    return;
  }
  
  // New session
  const server = new McpServer({ name: "http-server", version: "1.0.0" });
  // ... register tools/resources/prompts ...
  
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  });
  
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  
  if (transport.sessionId) {
    sessions[transport.sessionId] = transport;
  }
});

app.listen(3000);
```

---

## Python SDK implementation

### Installation

```bash
# Using uv (recommended)
uv add "mcp[cli]"

# Using pip
pip install "mcp[cli]"
```

**Requirements:** Python 3.10+

### Complete server example

**pyproject.toml:**
```toml
[project]
name = "mcp-demo-server"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["mcp[cli]>=1.2.0", "httpx>=0.27.0"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project.scripts]
mcp-demo = "server:main"
```

**server.py:**
```python
"""
Complete MCP Server Example
Run with: uv run server.py
"""
from typing import Any
from pydantic import BaseModel, Field
from mcp.server.fastmcp import FastMCP, Context
from mcp.server.fastmcp.prompts import base
from mcp import types

mcp = FastMCP("Demo Server", json_response=True)


# ============ TOOLS ============

@mcp.tool()
def add(a: int, b: int) -> int:
    """Add two integers.
    
    Args:
        a: First number
        b: Second number
    """
    return a + b


class CalculationInput(BaseModel):
    """Input for calculations."""
    operation: str = Field(description="Operation: add, subtract, multiply, divide")
    x: float = Field(description="First operand")
    y: float = Field(description="Second operand")


@mcp.tool()
def calculate(input: CalculationInput) -> dict[str, Any]:
    """Perform a calculation with validated input."""
    operations = {
        "add": lambda x, y: x + y,
        "subtract": lambda x, y: x - y,
        "multiply": lambda x, y: x * y,
        "divide": lambda x, y: x / y if y != 0 else None,
    }
    
    op = operations.get(input.operation.lower())
    if not op:
        return {"error": f"Unknown operation: {input.operation}"}
    
    result = op(input.x, input.y)
    if result is None:
        return {"error": "Division by zero"}
    
    return {"operation": input.operation, "x": input.x, "y": input.y, "result": result}


@mcp.tool()
async def process_with_logging(data: str, ctx: Context) -> str:
    """Process data with progress logging.
    
    Args:
        data: Data to process
        ctx: MCP context (injected automatically)
    """
    await ctx.info(f"Processing: {data[:50]}...")
    await ctx.report_progress(50, 100)
    result = data.upper()
    await ctx.report_progress(100, 100)
    return result


# ============ RESOURCES ============

@mcp.resource("config://app/info")
def get_app_info() -> dict[str, str]:
    """Get application information."""
    return {"name": "Demo Server", "version": "1.0.0"}


@mcp.resource("users://{user_id}/profile")
def get_user_profile(user_id: int) -> dict[str, Any]:
    """Get a user's profile by ID.
    
    Args:
        user_id: The user's unique identifier
    """
    return {"id": user_id, "name": f"User {user_id}", "status": "active"}


@mcp.resource("greeting://{name}")
def get_greeting(name: str) -> str:
    """Get a personalized greeting."""
    return f"Hello, {name}! Welcome to the MCP server."


# ============ PROMPTS ============

@mcp.prompt()
def summarize_text(text: str) -> str:
    """Generate a summarization prompt.
    
    Args:
        text: Text to summarize
    """
    return f"Please summarize this text concisely:\n\n{text}"


@mcp.prompt()
def code_review(code: str, language: str = "python") -> str:
    """Generate a code review prompt.
    
    Args:
        code: Code to review
        language: Programming language
    """
    return f"""Review this {language} code for:
1. Bugs and issues
2. Best practices
3. Performance
4. Security

```{language}
{code}
```"""


@mcp.prompt()
def debug_error(error_message: str, context: str = "") -> list[base.Message]:
    """Generate a debugging conversation prompt.
    
    Args:
        error_message: The error to debug
        context: Additional context
    """
    messages = [base.UserMessage(f"I'm seeing this error:\n\n```\n{error_message}\n```")]
    if context:
        messages.append(base.UserMessage(f"Context: {context}"))
    messages.append(base.AssistantMessage("I'll help debug this. Let me analyze..."))
    return messages


# ============ MAIN ============

def main():
    """Run the MCP server."""
    import sys
    transport = sys.argv[1] if len(sys.argv) > 1 else "stdio"
    
    if transport in ("http", "streamable-http"):
        mcp.run(transport="streamable-http", host="127.0.0.1", port=8000, path="/mcp")
    else:
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
```

### Running the Python server

```bash
# STDIO transport (default)
uv run server.py
# or
python server.py

# HTTP transport
uv run server.py http

# Using MCP CLI
uv run mcp run server.py

# Testing with inspector
npx @modelcontextprotocol/inspector
```

---

## Configuration for Claude applications

### Claude Desktop configuration

**File locations:**
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

**JSON structure:**
```json
{
  "mcpServers": {
    "server-name": {
      "command": "executable",
      "args": ["arg1", "arg2"],
      "env": {
        "API_KEY": "your-key"
      }
    }
  }
}
```

**Example configurations:**

```json
{
  "mcpServers": {
    "demo-typescript": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"]
    },
    "demo-python": {
      "command": "uv",
      "args": ["--directory", "/absolute/path/to/project", "run", "server.py"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxx"
      }
    }
  }
}
```

### Claude Code configuration

**File locations:**
- **Project scope:** `.mcp.json` in project root (version controlled)
- **Local scope:** `~/.claude.json` (personal, not shared)
- **User scope:** `~/.claude.json` (cross-project)

**JSON structure (supports HTTP directly):**
```json
{
  "mcpServers": {
    "local-server": {
      "type": "stdio",
      "command": "python",
      "args": ["server.py"],
      "env": {}
    },
    "remote-server": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      }
    }
  }
}
```

**CLI commands:**
```bash
# Add servers
claude mcp add --transport stdio myserver -- python server.py
claude mcp add --transport http remote-api https://api.example.com/mcp

# Import from Claude Desktop
claude mcp add-from-claude-desktop

# Manage servers
claude mcp list
claude mcp get <name>
claude mcp remove <name>

# Check status inside Claude Code
/mcp
```

### Log locations for troubleshooting

- **macOS:** `~/Library/Logs/Claude/mcp*.log`
- **Windows:** `%APPDATA%\Claude\logs\`

```bash
# Watch logs in real-time
tail -f ~/Library/Logs/Claude/mcp*.log
```

---

## Recent protocol updates (2025-2026)

### Spec version timeline

| Version | Date | Key Changes |
|---------|------|-------------|
| 2024-11-05 | Nov 2024 | Initial release with HTTP+SSE |
| 2025-03-26 | Mar 2025 | **Streamable HTTP transport** |
| 2025-06-18 | Jun 2025 | Structured outputs, OAuth 2.1, elicitation |
| **2025-11-25** | Nov 2025 | Tasks primitive, extensions framework, enhanced OAuth |

### Major 2025-2026 additions

**Streamable HTTP transport** replaces the old separate SSE/POST endpoints with a single unified endpoint. Sessions are managed via `Mcp-Session-Id` header, and responses can be JSON or SSE streams.

**OAuth 2.1 with PKCE** is now the standard authentication mechanism. The 2025-11-25 spec adds OAuth Client ID Metadata Documents (URL-based client registration without DCR) and incremental scope consent via `WWW-Authenticate` headers.

**Structured tool outputs** allow tools to define `outputSchema` and return `structuredContent` alongside human-readable `content`, enabling reliable programmatic access to tool results.

**Tasks primitive** (experimental) tracks long-running operations with states like `working`, `completed`, `failed`. Useful for operations that span minutes to hours.

**Extensions framework** formalizes optional protocol extensions. First extension: MCP Apps for interactive UI components.

**Sampling with tools** enables server-side agent loops via `tools` and `toolChoice` parameters in sampling requests.

### SDK versions

- **TypeScript SDK:** v2.x (`@modelcontextprotocol/sdk`), supports 2025-11-25 spec
- **Python SDK:** v1.x stable, v2 in development (expected Q1 2026)

### Governance change

In December 2025, Anthropic donated MCP to the **Agentic AI Foundation** under the Linux Foundation, co-founded with OpenAI and Block. The protocol now has **97M+ monthly SDK downloads** and **10,000+ active servers**.

---

## Quick reference

### Method summary

| Method | Direction | Purpose |
|--------|-----------|---------|
| `initialize` | Client → Server | Start session, negotiate capabilities |
| `notifications/initialized` | Client → Server | Confirm initialization |
| `tools/list` | Client → Server | Discover tools |
| `tools/call` | Client → Server | Execute tool |
| `resources/list` | Client → Server | Discover resources |
| `resources/read` | Client → Server | Read resource content |
| `resources/subscribe` | Client → Server | Subscribe to changes |
| `prompts/list` | Client → Server | Discover prompts |
| `prompts/get` | Client → Server | Get prompt messages |
| `sampling/createMessage` | Server → Client | Request LLM completion |
| `logging/setLevel` | Client → Server | Set log verbosity |
| `notifications/message` | Server → Client | Log message |

### Run commands summary

```bash
# TypeScript (after build)
node dist/index.js                    # Direct
npx -y my-mcp-server                  # Published package

# Python
uv run server.py                      # With uv
python server.py                      # Direct
uv run mcp run server.py              # MCP CLI

# Testing
npx @modelcontextprotocol/inspector   # MCP Inspector GUI
```

### Minimal server checklist

1. ✅ Create server with name and version
2. ✅ Register at least one tool, resource, or prompt  
3. ✅ Set up transport (stdio for local, HTTP for remote)
4. ✅ Connect transport to server
5. ✅ Log to stderr only (never stdout for stdio transport)
6. ✅ Return `isError: true` for tool failures
7. ✅ Configure in Claude Desktop/Code with absolute paths