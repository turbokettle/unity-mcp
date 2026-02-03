# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This project contains two components:
1. **Unity Editor Plugin** - C# scripts in `Assets/Editor/MCP/` that run inside Unity and expose functionality via a local TCP server
2. **MCP Server** - TypeScript server in `mcp-server/` that bridges Claude Code to Unity via the Model Context Protocol

The Unity plugin and MCP server communicate over TCP (port 6400).

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
Open the project in Unity 6000.0.65f1. The Editor scripts compile automatically.

## Architecture

### Unity Side (`Assets/Editor/MCP/`)
- `MCPServer.cs` - TCP server listening for commands from the MCP server
- `MCPBridge.cs` - Routes incoming commands to appropriate handlers
- `Protocol.cs` - JSON message serialization/deserialization
- `Commands/` - Individual command implementations (GetLogsCommand, ExecMenuCommand)
- `WindowWaker.cs` - Keeps Unity responsive when minimized/unfocused

### MCP Server Side (`mcp-server/src/`)
- `index.ts` - MCP server entry point, tool definitions
- `unity-connection.ts` - TCP client connecting to Unity
- `unity-finder.ts` - Locates running Unity instances
- `tools/` - MCP tool implementations

## MCP Protocol Reference

Reference documentation for building MCP servers is available at `mcp-reference.md`. This includes:
- Protocol specification (JSON-RPC 2.0, transports, lifecycle)
- TypeScript and Python SDK implementation examples
- Configuration for Claude Desktop and Claude Code
