using UnityEditor;
using UnityEngine;

namespace UnityMCP
{
    /// <summary>
    /// Handles the exec_menu command by executing Unity Editor menu items.
    /// Requires main thread execution.
    /// </summary>
    public class ExecMenuCommand
    {
        public MCPResponse Handle(MCPRequest request)
        {
            var prms = request.GetParams<ExecMenuParams>();

            if (prms == null || string.IsNullOrEmpty(prms.path))
            {
                return MCPResponse.Error(request.id, "Missing 'path' parameter");
            }

            var path = prms.path;

            // Validate menu item exists
            // Note: There's no built-in way to check if a menu item exists,
            // so we just try to execute it and handle failure

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

            return MCPResponse.Success(request.id, response);
        }
    }
}
