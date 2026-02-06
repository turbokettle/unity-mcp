using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEngine;

namespace UnityMCP
{
    /// <summary>
    /// TCP server that listens for MCP commands from the Node.js sidecar.
    /// Runs on a background thread to stay responsive even when Unity is minimized.
    /// </summary>
    public class MCPServer : IDisposable
    {
        private TcpListener _listener;
        private Thread _listenerThread;
        private volatile bool _running;
        private int _port;

        // Pending requests that need main thread execution
        private readonly ConcurrentQueue<PendingRequest> _mainThreadQueue = new ConcurrentQueue<PendingRequest>();

        // Active client connections
        private readonly ConcurrentDictionary<int, TcpClient> _clients = new ConcurrentDictionary<int, TcpClient>();
        private int _clientIdCounter;

        // Tool registry for dynamic tool discovery
        public ToolRegistry Registry { get; set; }

        // Ping handler (still needed for connection validation)
        public Func<MCPRequest, MCPResponse> OnPing;

        public int Port => _port;
        public bool IsRunning => _running;

        private class PendingRequest
        {
            public MCPRequest Request;
            public TcpClient Client;
            public NetworkStream Stream;
        }

        public void Start()
        {
            if (_running) return;

            try
            {
                // Bind to dynamic port on localhost
                _listener = new TcpListener(IPAddress.Loopback, 0);
                _listener.Start();
                _port = ((IPEndPoint)_listener.LocalEndpoint).Port;

                _running = true;

                _listenerThread = new Thread(ListenerLoop)
                {
                    IsBackground = true,
                    Name = "MCP-TCPListener"
                };
                _listenerThread.Start();

                Debug.Log($"[MCP] Server started on port {_port}");
            }
            catch (Exception e)
            {
                Debug.LogError($"[MCP] Failed to start server: {e.Message}");
                _running = false;
            }
        }

        public void Stop()
        {
            _running = false;

            try
            {
                _listener?.Stop();
            }
            catch { }

            // Close all client connections
            foreach (var kvp in _clients)
            {
                try
                {
                    kvp.Value?.Close();
                }
                catch { }
            }
            _clients.Clear();

            Debug.Log("[MCP] Server stopped");
        }

        private void ListenerLoop()
        {
            while (_running)
            {
                try
                {
                    if (_listener.Pending())
                    {
                        var client = _listener.AcceptTcpClient();
                        var clientId = Interlocked.Increment(ref _clientIdCounter);
                        _clients[clientId] = client;

                        var clientThread = new Thread(() => HandleClient(clientId, client))
                        {
                            IsBackground = true,
                            Name = $"MCP-Client-{clientId}"
                        };
                        clientThread.Start();

                        Debug.Log($"[MCP] Client {clientId} connected");
                    }
                    else
                    {
                        Thread.Sleep(50); // Avoid busy-waiting
                    }
                }
                catch (SocketException) when (!_running)
                {
                    // Expected when stopping
                }
                catch (Exception e)
                {
                    if (_running)
                    {
                        Debug.LogError($"[MCP] Listener error: {e.Message}");
                        Thread.Sleep(1000); // Back off on error
                    }
                }
            }
        }

        private void HandleClient(int clientId, TcpClient client)
        {
            try
            {
                client.ReceiveTimeout = 0; // No timeout for persistent connections
                var stream = client.GetStream();
                var reader = new StreamReader(stream, Encoding.UTF8);

                while (_running && client.Connected)
                {
                    try
                    {
                        var line = reader.ReadLine();
                        if (line == null)
                        {
                            // Client disconnected
                            break;
                        }

                        if (string.IsNullOrWhiteSpace(line))
                            continue;

                        ProcessMessage(line, client, stream);
                    }
                    catch (IOException)
                    {
                        // Connection closed
                        break;
                    }
                    catch (Exception e)
                    {
                        Debug.LogError($"[MCP] Error processing message from client {clientId}: {e.Message}");
                    }
                }
            }
            catch (Exception e)
            {
                Debug.LogError($"[MCP] Client {clientId} handler error: {e.Message}");
            }
            finally
            {
                _clients.TryRemove(clientId, out _);
                try { client?.Close(); } catch { }
                Debug.Log($"[MCP] Client {clientId} disconnected");
            }
        }

        private void ProcessMessage(string json, TcpClient client, NetworkStream stream)
        {
            MCPRequest request = null;
            try
            {
                request = JsonUtility.FromJson<MCPRequest>(json);
            }
            catch (Exception e)
            {
                Debug.LogError($"[MCP] Failed to parse request: {e.Message}");
                SendResponse(stream, MCPResponse.Error("unknown", "Invalid JSON"));
                return;
            }

            if (request == null || string.IsNullOrEmpty(request.cmd))
            {
                SendResponse(stream, MCPResponse.Error(request?.id ?? "unknown", "Missing command"));
                return;
            }

            // Check if command requires main thread
            if (request.RequiresMainThread(Registry))
            {
                // Queue for main thread and wake window if minimized
                _mainThreadQueue.Enqueue(new PendingRequest
                {
                    Request = request,
                    Client = client,
                    Stream = stream
                });

                // Wake Unity if minimized so main thread can process
                WindowWaker.WakeIfMinimized();
            }
            else
            {
                // Handle on background thread
                var response = HandleCommand(request);
                SendResponse(stream, response);
            }
        }

        private MCPResponse HandleCommand(MCPRequest request)
        {
            try
            {
                switch (request.cmd)
                {
                    case "ping":
                        return OnPing?.Invoke(request) ?? MCPResponse.Error(request.id, "Ping handler not registered");

                    case "list_tools":
                        return HandleListTools(request);

                    case "invoke_tool":
                        return HandleInvokeTool(request);

                    default:
                        return MCPResponse.Error(request.id, $"Unknown command: {request.cmd}");
                }
            }
            catch (Exception e)
            {
                Debug.LogError($"[MCP] Command '{request.cmd}' failed: {e.Message}\n{e.StackTrace}");
                return MCPResponse.Error(request.id, $"Command failed: {e.Message}");
            }
        }

        private MCPResponse HandleListTools(MCPRequest request)
        {
            if (Registry == null)
            {
                return MCPResponse.Error(request.id, "Tool registry not initialized");
            }

            var toolList = Registry.GetToolList();
            return MCPResponse.Success(request.id, toolList);
        }

        private MCPResponse HandleInvokeTool(MCPRequest request)
        {
            if (Registry == null)
            {
                return MCPResponse.Error(request.id, "Tool registry not initialized");
            }

            var invokeParams = request.GetParams<InvokeToolParams>();
            if (invokeParams == null || string.IsNullOrEmpty(invokeParams.tool))
            {
                return MCPResponse.Error(request.id, "Missing 'tool' parameter");
            }

            if (!Registry.TryGetTool(invokeParams.tool, out var tool))
            {
                return MCPResponse.Error(request.id, $"Unknown tool: {invokeParams.tool}");
            }

            return tool.Execute(request.id, invokeParams.arguments);
        }

        private void SendResponse(NetworkStream stream, MCPResponse response)
        {
            try
            {
                var json = response.ToJson() + "\n";
                var bytes = Encoding.UTF8.GetBytes(json);
                lock (stream)
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush();
                }
            }
            catch (Exception e)
            {
                Debug.LogError($"[MCP] Failed to send response: {e.Message}");
            }
        }

        /// <summary>
        /// Process pending main-thread requests. Call this from EditorApplication.update.
        /// </summary>
        public void ProcessMainThreadQueue()
        {
            int processed = 0;
            while (_mainThreadQueue.TryDequeue(out var pending))
            {
                try
                {
                    var response = HandleCommand(pending.Request);
                    SendResponse(pending.Stream, response);
                    processed++;
                }
                catch (Exception e)
                {
                    Debug.LogError($"[MCP] Main thread processing failed: {e.Message}");
                    try
                    {
                        SendResponse(pending.Stream, MCPResponse.Error(pending.Request.id, e.Message));
                    }
                    catch { }
                }
            }

            // If we processed commands and window was woken by us, re-minimize
            if (processed > 0 && WindowWaker.ShouldRestoreMinimized)
            {
                WindowWaker.RestoreMinimizedState();
            }
        }

        public void Dispose()
        {
            Stop();
        }
    }
}
