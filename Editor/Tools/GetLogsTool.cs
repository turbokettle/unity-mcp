using System;
using System.Collections.Generic;
using UnityEngine;

namespace UnityMCP.Tools
{
    /// <summary>
    /// Parameters for the get_logs tool.
    /// </summary>
    [Serializable]
    public class GetLogsParams
    {
        [ToolParameter("Number of log entries to retrieve (1-1000)", DefaultValue = 50, Min = 1, Max = 1000)]
        public int count = 50;

        [ToolParameter("Filter logs by type", DefaultValue = "all", EnumValues = new[] { "all", "errors", "warnings" })]
        public string filter = "all";
    }

    /// <summary>
    /// Tool for reading Unity Editor console logs.
    /// Maintains a circular buffer of recent log entries.
    /// </summary>
    public class GetLogsTool : IMcpTool, IDisposable
    {
        private const int MaxLogEntries = 1000;

        private readonly object _lock = new object();
        private readonly LinkedList<LogEntry> _logs = new LinkedList<LogEntry>();
        private bool _subscribed = false;

        public string Name => "read_console_logs";

        public string Description => "Read Unity Editor console logs. Returns recent log messages including errors, warnings, and info logs.";

        public bool RequiresMainThread => false;

        public GetLogsTool()
        {
            Subscribe();
        }

        private void Subscribe()
        {
            if (_subscribed) return;
            Application.logMessageReceived += OnLogMessage;
            _subscribed = true;
        }

        public void Dispose()
        {
            if (_subscribed)
            {
                Application.logMessageReceived -= OnLogMessage;
                _subscribed = false;
            }
        }

        private void OnLogMessage(string message, string stackTrace, LogType type)
        {
            var entry = new LogEntry
            {
                message = message,
                stackTrace = stackTrace,
                type = type.ToString(),
                timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff")
            };

            lock (_lock)
            {
                _logs.AddLast(entry);

                // Trim to max size
                while (_logs.Count > MaxLogEntries)
                {
                    _logs.RemoveFirst();
                }
            }
        }

        public ToolParameterSchema GetParameterSchema()
        {
            return SchemaBuilder.FromType<GetLogsParams>();
        }

        public MCPResponse Execute(string id, string paramsJson)
        {
            var prms = string.IsNullOrEmpty(paramsJson)
                ? new GetLogsParams()
                : JsonUtility.FromJson<GetLogsParams>(paramsJson) ?? new GetLogsParams();

            int count = Math.Max(1, Math.Min(prms.count, MaxLogEntries));
            string filter = prms.filter ?? "all";

            var result = new LogsResponse();

            lock (_lock)
            {
                // Get logs from newest to oldest, then reverse
                var node = _logs.Last;
                while (node != null && result.logs.Count < count)
                {
                    var entry = node.Value;

                    bool include = filter switch
                    {
                        "errors" => entry.type == "Error" || entry.type == "Exception" || entry.type == "Assert",
                        "warnings" => entry.type == "Warning",
                        _ => true
                    };

                    if (include)
                    {
                        result.logs.Add(entry);
                    }

                    node = node.Previous;
                }
            }

            // Reverse to get chronological order
            result.logs.Reverse();

            return MCPResponse.Success(id, result);
        }
    }
}
