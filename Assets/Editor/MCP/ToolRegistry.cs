using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEngine;

namespace UnityMCP
{
    /// <summary>
    /// Registry for discovering and managing MCP tools.
    /// Scans assemblies for IMcpTool implementations and provides lookup functionality.
    /// </summary>
    public class ToolRegistry
    {
        private readonly Dictionary<string, IMcpTool> _tools = new Dictionary<string, IMcpTool>();
        private int _version = 0;

        /// <summary>
        /// Version number, incremented each time tools are rediscovered.
        /// Used by the MCP server to detect changes.
        /// </summary>
        public int Version => _version;

        /// <summary>
        /// Number of registered tools.
        /// </summary>
        public int Count => _tools.Count;

        /// <summary>
        /// Discover all IMcpTool implementations in loaded assemblies.
        /// Clears existing registrations and rescans.
        /// </summary>
        public void DiscoverTools()
        {
            _tools.Clear();
            _version++;

            var toolInterface = typeof(IMcpTool);

            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                // Skip system assemblies
                if (assembly.FullName.StartsWith("System") ||
                    assembly.FullName.StartsWith("mscorlib") ||
                    assembly.FullName.StartsWith("Unity") ||
                    assembly.FullName.StartsWith("netstandard"))
                {
                    continue;
                }

                try
                {
                    foreach (var type in assembly.GetTypes())
                    {
                        if (type.IsAbstract || type.IsInterface)
                            continue;

                        if (!toolInterface.IsAssignableFrom(type))
                            continue;

                        try
                        {
                            var tool = (IMcpTool)Activator.CreateInstance(type);
                            RegisterTool(tool);
                        }
                        catch (Exception ex)
                        {
                            Debug.LogWarning($"[MCP] Failed to instantiate tool {type.Name}: {ex.Message}");
                        }
                    }
                }
                catch (ReflectionTypeLoadException ex)
                {
                    // Some assemblies may have unresolvable dependencies
                    Debug.LogWarning($"[MCP] Error scanning assembly {assembly.GetName().Name}: {ex.Message}");
                }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[MCP] Error scanning assembly {assembly.GetName().Name}: {ex.Message}");
                }
            }

            Debug.Log($"[MCP] Discovered {_tools.Count} tools");
        }

        /// <summary>
        /// Manually register a tool instance.
        /// </summary>
        public void RegisterTool(IMcpTool tool)
        {
            if (tool == null)
            {
                Debug.LogWarning("[MCP] Attempted to register null tool");
                return;
            }

            if (string.IsNullOrEmpty(tool.Name))
            {
                Debug.LogWarning($"[MCP] Tool {tool.GetType().Name} has empty name");
                return;
            }

            if (_tools.ContainsKey(tool.Name))
            {
                Debug.LogWarning($"[MCP] Duplicate tool name: {tool.Name}");
                return;
            }

            _tools[tool.Name] = tool;
            Debug.Log($"[MCP] Registered tool: {tool.Name}");
        }

        /// <summary>
        /// Try to get a tool by name.
        /// </summary>
        public bool TryGetTool(string name, out IMcpTool tool)
        {
            return _tools.TryGetValue(name, out tool);
        }

        /// <summary>
        /// Get a tool by name, or null if not found.
        /// </summary>
        public IMcpTool GetTool(string name)
        {
            _tools.TryGetValue(name, out var tool);
            return tool;
        }

        /// <summary>
        /// Get info for all registered tools.
        /// </summary>
        public ToolListResponse GetToolList()
        {
            var response = new ToolListResponse
            {
                version = _version,
                tools = new List<ToolInfo>()
            };

            foreach (var tool in _tools.Values)
            {
                response.tools.Add(new ToolInfo
                {
                    name = tool.Name,
                    description = tool.Description,
                    requiresMainThread = tool.RequiresMainThread,
                    parameterSchema = tool.GetParameterSchema().ToJson()
                });
            }

            return response;
        }

        /// <summary>
        /// Get all registered tools.
        /// </summary>
        public IEnumerable<IMcpTool> GetAllTools()
        {
            return _tools.Values;
        }
    }
}
