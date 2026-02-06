namespace UnityMCP
{
    /// <summary>
    /// Interface for MCP tools that can be discovered and invoked dynamically.
    /// Implement this interface to create tools that will be automatically
    /// exposed to Claude Code via the MCP protocol.
    /// </summary>
    public interface IMcpTool
    {
        /// <summary>
        /// Unique identifier for the tool (snake_case, e.g., "read_console_logs").
        /// This name is used by Claude Code to invoke the tool.
        /// </summary>
        string Name { get; }

        /// <summary>
        /// Human-readable description shown to Claude Code.
        /// Describe what the tool does and when to use it.
        /// </summary>
        string Description { get; }

        /// <summary>
        /// Whether this tool must execute on Unity's main thread.
        /// Set to true for tools that use Unity APIs requiring main thread access.
        /// </summary>
        bool RequiresMainThread { get; }

        /// <summary>
        /// Returns the JSON Schema describing this tool's parameters.
        /// Used by Claude Code to understand valid inputs.
        /// </summary>
        ToolParameterSchema GetParameterSchema();

        /// <summary>
        /// Execute the tool with the given parameters.
        /// </summary>
        /// <param name="id">Request ID for the response.</param>
        /// <param name="paramsJson">JSON string containing the parameters.</param>
        /// <returns>MCPResponse with the result or error.</returns>
        MCPResponse Execute(string id, string paramsJson);
    }
}
