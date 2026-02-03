using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace UnityMCP
{
    /// <summary>
    /// Bootstrap class that initializes the MCP server when Unity loads.
    /// Uses [InitializeOnLoad] to start automatically.
    /// </summary>
    [InitializeOnLoad]
    public static class MCPBridge
    {
        private static MCPServer _server;
        private static ToolRegistry _registry;
        private static bool _initialized;

        // Cached values (must be read on main thread, then used from background thread)
        private static string _cachedUnityVersion;
        private static string _cachedProjectName;

        static MCPBridge()
        {
            // Defer initialization to first editor update to ensure Unity is fully loaded
            EditorApplication.update += InitializeOnce;
        }

        private static void InitializeOnce()
        {
            EditorApplication.update -= InitializeOnce;

            if (_initialized) return;
            _initialized = true;

            Initialize();
        }

        private static void Initialize()
        {
            // Cache values that can only be read on main thread
            _cachedUnityVersion = Application.unityVersion;
            _cachedProjectName = Application.productName;

            // Initialize WindowWaker on main thread
            WindowWaker.Initialize();

            // Create and initialize tool registry
            _registry = new ToolRegistry();
            _registry.DiscoverTools();

            // Create and configure server
            _server = new MCPServer
            {
                OnPing = HandlePing,
                Registry = _registry
            };

            // Start server
            _server.Start();

            // Write instance info for sidecar to discover
            WriteInstanceInfo();

            // Register for editor update to process main thread queue
            EditorApplication.update += OnEditorUpdate;

            // Register for domain unload cleanup
            AppDomain.CurrentDomain.DomainUnload += OnDomainUnload;

            // Register for editor quit
            EditorApplication.quitting += OnEditorQuitting;

            Debug.Log($"[MCP] Bridge initialized - server running on port {_server.Port}");
        }

        private static void OnEditorUpdate()
        {
            _server?.ProcessMainThreadQueue();
        }

        private static void OnDomainUnload(object sender, EventArgs e)
        {
            Shutdown();
        }

        private static void OnEditorQuitting()
        {
            Shutdown();
        }

        private static void Shutdown()
        {
            if (_server != null)
            {
                _server.Dispose();
                _server = null;
            }

            // Dispose tools that implement IDisposable
            if (_registry != null)
            {
                foreach (var tool in _registry.GetAllTools())
                {
                    if (tool is IDisposable disposable)
                    {
                        disposable.Dispose();
                    }
                }
                _registry = null;
            }

            // Remove instance file
            DeleteInstanceInfo();

            Debug.Log("[MCP] Bridge shut down");
        }

        private static MCPResponse HandlePing(MCPRequest request)
        {
            var response = new PingResponse
            {
                status = "ok",
                unityVersion = _cachedUnityVersion,
                projectName = _cachedProjectName
            };
            return MCPResponse.Success(request.id, response);
        }

        private static void WriteInstanceInfo()
        {
            try
            {
                var info = new MCPInstanceInfo
                {
                    port = _server.Port,
                    pid = System.Diagnostics.Process.GetCurrentProcess().Id,
                    projectPath = Directory.GetCurrentDirectory()
                };

                var libraryPath = Path.Combine(Directory.GetCurrentDirectory(), "Library");
                if (!Directory.Exists(libraryPath))
                {
                    Debug.LogWarning("[MCP] Library folder not found, cannot write instance info");
                    return;
                }

                var instancePath = Path.Combine(libraryPath, "MCPInstance.json");
                var json = JsonUtility.ToJson(info, true);
                File.WriteAllText(instancePath, json);

                Debug.Log($"[MCP] Instance info written to {instancePath}");
            }
            catch (Exception e)
            {
                Debug.LogError($"[MCP] Failed to write instance info: {e.Message}");
            }
        }

        private static void DeleteInstanceInfo()
        {
            try
            {
                var instancePath = Path.Combine(Directory.GetCurrentDirectory(), "Library", "MCPInstance.json");
                if (File.Exists(instancePath))
                {
                    File.Delete(instancePath);
                }
            }
            catch
            {
                // Ignore errors during cleanup
            }
        }
    }
}
