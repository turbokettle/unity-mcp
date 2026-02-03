using System;
using System.Collections.Generic;
using UnityEngine;

namespace UnityMCP
{
    /// <summary>
    /// Handles the get_logs command by capturing Unity console output.
    /// Maintains a circular buffer of recent log entries.
    /// </summary>
    public class GetLogsCommand : IDisposable
    {
        private const int MaxLogEntries = 1000;

        private readonly object _lock = new object();
        private readonly LinkedList<LogEntry> _logs = new LinkedList<LogEntry>();

        public GetLogsCommand()
        {
            Application.logMessageReceived += OnLogMessage;
        }

        public void Dispose()
        {
            Application.logMessageReceived -= OnLogMessage;
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

        public MCPResponse Handle(MCPRequest request)
        {
            var prms = request.GetParams<GetLogsParams>() ?? new GetLogsParams();
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

            return MCPResponse.Success(request.id, result);
        }
    }
}
