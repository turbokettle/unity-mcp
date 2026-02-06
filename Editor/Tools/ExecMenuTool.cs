using System;
using UnityEditor;
using UnityEngine;

namespace UnityMCP.Tools
{
    /// <summary>
    /// Parameters for the exec_menu tool.
    /// </summary>
    [Serializable]
    public class ExecMenuParams
    {
        [ToolParameter("Menu item path (e.g., 'File/Save Scene', 'Edit/Play', 'Assets/Refresh')", Required = true)]
        public string path;
    }

    /// <summary>
    /// Tool for executing Unity Editor menu items.
    /// Requires main thread execution.
    /// </summary>
    public class ExecMenuTool : IMcpTool
    {
        public string Name => "execute_menu_item";

        public string Description => "Execute a Unity Editor menu item by its path. Use this to trigger Unity actions like saving scenes, refreshing assets, entering play mode, etc.";

        public bool RequiresMainThread => true;

        public ToolParameterSchema GetParameterSchema()
        {
            return SchemaBuilder.FromType<ExecMenuParams>();
        }

        public MCPResponse Execute(string id, string paramsJson)
        {
            var prms = string.IsNullOrEmpty(paramsJson)
                ? null
                : JsonUtility.FromJson<ExecMenuParams>(paramsJson);

            if (prms == null || string.IsNullOrEmpty(prms.path))
            {
                return MCPResponse.Error(id, "Missing 'path' parameter");
            }

            var path = prms.path;

            Debug.Log($"[MCP] Executing menu item: {path}");

            bool success = EditorApplication.ExecuteMenuItem(path);

            var response = new ExecMenuResponse
            {
                success = success,
                message = success
                    ? $"Successfully executed menu item: {path}"
                    : $"Failed to execute menu item: {path}. The menu item may not exist or is disabled."
            };

            if (!success)
            {
                Debug.LogWarning($"[MCP] Failed to execute menu item: {path}");
            }

            return MCPResponse.Success(id, response);
        }
    }
}
