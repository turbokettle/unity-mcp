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

        public bool RequiresMainThread =>
            cmd == "exec_menu" ||
            cmd == "recompile";
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

    // Parameter types for commands
    [Serializable]
    public class GetLogsParams
    {
        public int count = 50;
        public string filter = "all"; // "all", "errors", "warnings"
    }

    [Serializable]
    public class ExecMenuParams
    {
        public string path;
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

    // Instance info written to Library/MCPInstance.json
    [Serializable]
    public class MCPInstanceInfo
    {
        public int port;
        public int pid;
        public string projectPath;
    }
}
