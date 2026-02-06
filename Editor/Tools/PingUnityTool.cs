using System;
using UnityEngine;

namespace UnityMCP.Tools
{
    [Serializable]
    public class PingUnityResponse
    {
        public string message;
        public string timestamp;
        public long uptimeSeconds;
    }

    /// <summary>
    /// Simple ping tool to verify Unity is responding.
    /// </summary>
    public class PingUnityTool : IMcpTool
    {
        private readonly DateTime _startTime = DateTime.Now;

        public string Name => "ping_unity";

        public string Description => "Ping Unity Editor to verify it's responding. Returns a timestamp and uptime.";

        public bool RequiresMainThread => false;

        public ToolParameterSchema GetParameterSchema()
        {
            return SchemaBuilder.Empty();
        }

        public MCPResponse Execute(string id, string paramsJson)
        {
            var response = new PingUnityResponse
            {
                message = "pong",
                timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff"),
                uptimeSeconds = (long)(DateTime.Now - _startTime).TotalSeconds
            };

            return MCPResponse.Success(id, response);
        }
    }
}
