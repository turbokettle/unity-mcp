using System;
using System.Collections.Generic;
using UnityEngine;

namespace UnityMCP
{
    [Serializable]
    public class MCPRequest
    {
        public string id;
        public string cmd;
        public string @params; // JSON string of parameters

        public T GetParams<T>()
        {
            if (string.IsNullOrEmpty(@params))
                return default;
            return JsonUtility.FromJson<T>(@params);
        }

        /// <summary>
        /// Determines if this request requires main thread execution.
        /// For invoke_tool commands, looks up the tool in the registry.
        /// </summary>
        public bool RequiresMainThread(ToolRegistry registry)
        {
            if (cmd == "invoke_tool" && registry != null)
            {
                var invokeParams = GetParams<InvokeToolParams>();
                if (invokeParams != null && !string.IsNullOrEmpty(invokeParams.tool))
                {
                    if (registry.TryGetTool(invokeParams.tool, out var tool))
                    {
                        return tool.RequiresMainThread;
                    }
                }
            }
            return false;
        }
    }

    [Serializable]
    public class MCPResponse
    {
        public string id;
        public bool ok;
        public string data;
        public string error;

        public static MCPResponse Success(string id, object data)
        {
            return new MCPResponse
            {
                id = id,
                ok = true,
                data = data != null ? JsonUtility.ToJson(data) : null
            };
        }

        public static MCPResponse Error(string id, string error)
        {
            return new MCPResponse
            {
                id = id,
                ok = false,
                error = error
            };
        }

        public string ToJson() => JsonUtility.ToJson(this);
    }

    // Parameter types for invoke_tool command
    [Serializable]
    public class InvokeToolParams
    {
        public string tool;
        public string arguments; // JSON string of tool-specific parameters
    }

    // Response data types
    [Serializable]
    public class LogEntry
    {
        public string message;
        public string stackTrace;
        public string type; // "Log", "Warning", "Error", "Exception", "Assert"
        public string timestamp;
    }

    [Serializable]
    public class LogsResponse
    {
        public List<LogEntry> logs = new List<LogEntry>();
    }

    [Serializable]
    public class ExecMenuResponse
    {
        public bool success;
        public string message;
    }

    [Serializable]
    public class PingResponse
    {
        public string status;
        public string unityVersion;
        public string projectName;
    }

    // Dynamic tool registration types
    [Serializable]
    public class ToolListResponse
    {
        public int version;
        public List<ToolInfo> tools = new List<ToolInfo>();
    }

    [Serializable]
    public class ToolInfo
    {
        public string name;
        public string description;
        public bool requiresMainThread;
        public string parameterSchema; // JSON Schema as string
    }

    // Instance info written to Library/MCPInstance.json
    [Serializable]
    public class MCPInstanceInfo
    {
        public int port;
        public int pid;
        public string projectPath;
    }
}
