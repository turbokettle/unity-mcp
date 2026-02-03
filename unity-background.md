# Real-time communication with Unity Editor while minimized

**The bottom line:** Background threads continue running when Unity Editor is minimized on Windows—but main-thread dispatch stops until the editor regains focus. The most robust solutions use a **sidecar process architecture** or **batch mode operation**, while socket-based IPC on background threads provides immediate bidirectional communication that queues responses for main-thread execution when Unity becomes active again.

When Unity Editor is minimized on Windows, `Update()`, `EditorApplication.update`, coroutines, and all main-thread callbacks stop firing completely. This is intentional—Unity throttles heavily to conserve resources. The `Application.runInBackground` setting only affects Player builds, not the Editor. No command-line argument, registry key, or Win32 API can override this behavior because it's hardcoded into Unity's internal message loop.

---

## Background threads are the foundation

The critical insight is that **background threads continue executing** even when the Editor is minimized. Socket listeners, pipe readers, and computation all proceed normally. The limitation is that work dispatched to Unity's main thread via `SynchronizationContext.Post()` or `EditorApplication.delayCall` queues up but doesn't execute until the editor window is restored.

This means any IPC mechanism running on a background thread can receive messages in real-time. The external service gets immediate acknowledgment. Only Unity API calls that require the main thread must wait. Here's the practical pattern:

```csharp
[InitializeOnLoad]
public class BackgroundIPCServer
{
    private static ConcurrentQueue<Action> mainThreadQueue = new();
    private static Thread serverThread;
    
    static BackgroundIPCServer()
    {
        serverThread = new Thread(RunServer) { IsBackground = true };
        serverThread.Start();
        EditorApplication.update += ProcessQueue;
    }
    
    static void RunServer()
    {
        // This continues running when minimized
        var listener = new TcpListener(IPAddress.Loopback, 8090);
        listener.Start();
        while (true)
        {
            var client = listener.AcceptTcpClient();
            // Handle messages, queue Unity work for later
            mainThreadQueue.Enqueue(() => DoUnityWork());
        }
    }
    
    static void ProcessQueue()
    {
        // Only runs when editor is active
        while (mainThreadQueue.TryDequeue(out var action))
            action?.Invoke();
    }
}
```

---

## IPC mechanisms ranked by effectiveness

### TCP/UDP sockets achieve the best balance

Socket-based communication offers the most reliable cross-platform solution. A TCP server on a background thread accepts connections, processes requests, and sends responses **immediately**—even when Unity is minimized. The external service doesn't block waiting for Unity.

**Advantages:** Standard .NET APIs work without modification. No native DLLs required. Can communicate across machines if needed. Well-documented patterns.

**Minimized behavior:** ✅ Fully operational. Receives and responds to messages in real-time. Only main-thread Unity API calls queue until restored.

### Named pipes offer lowest latency for same-machine IPC

Windows named pipes (`System.IO.Pipes`) provide the fastest same-machine communication. However, Unity has known issues with the managed implementation—`NamedPipeServerStream` in message mode can cause infinite loops where `IsMessageComplete` never returns true.

The recommended solution is [Lachee/unity-named-pipes](https://github.com/Lachee/unity-named-pipes), a native wrapper that avoids these issues. Requires API Compatibility Level set to **.NET 4.x** in Player Settings.

**Minimized behavior:** ✅ Background thread operations continue. Same caveats as TCP for main-thread dispatch.

### Memory-mapped files handle large data transfers

For scenarios involving large data payloads (images, serialized scenes, bulk asset data), memory-mapped files (`System.IO.MemoryMappedFiles`) with mutex synchronization provide the highest throughput. A background thread can poll or wait on a named `EventWaitHandle` for new data.

**Minimized behavior:** ✅ Background threads with `WaitOne()` continue operating. OS-level mechanism independent of Unity's frame loop.

### WebSocket servers require careful implementation

WebSocket implementations vary significantly in their minimized behavior:

- **WebSocketSharp** can run a server on internal threads that continues when minimized, but message callbacks still need Unity to process them
- **NativeWebSocket** requires calling `DispatchMessageQueue()` in `Update()`—messages won't process when minimized
- **System.Net.WebSockets** with `Task.Run()` for the receive loop works correctly on background threads

**Minimized behavior:** ⚠️ Depends on implementation. Raw socket-based approaches work; library convenience methods often don't.

### gRPC has compatibility complications

Unity lacks native HTTP/2 support, making standard gRPC problematic. The `Grpc.Core` package was deprecated in May 2023. Current solutions require either:

- [YetAnotherHttpHandler](https://github.com/Cysharp/yetanotherhttphandler) - enables grpc-dotnet via custom HTTP/2 handler
- gRPC-Web (HTTP/1.1 compatible) - but loses client streaming and bidirectional streaming

**Minimized behavior:** ⚠️ Tasks run on thread pool (works), but streaming operations may have edge cases.

---

## The sidecar architecture solves the problem definitively

The most robust solution runs a **companion process** alongside Unity that handles all external communication. The sidecar never minimizes, maintains persistent connections, and queues requests for Unity:

```
┌─────────────────────┐    Named Pipes    ┌─────────────────────┐
│   External Service  │◄────────────────►│   Sidecar Process   │
│   (Claude, MCP,     │                   │   (.NET Console)    │
│    other tools)     │                   │   - Always running  │
│                     │                   │   - Queues requests │
└─────────────────────┘                   └─────────┬───────────┘
                                                    │ Named Pipes/TCP
                                          ┌─────────▼───────────┐
                                          │   Unity Editor      │
                                          │   - May be minimized│
                                          │   - Processes when  │
                                          │     active          │
                                          └─────────────────────┘
```

This architecture is how professional tools solve the problem:

- **JetBrains Rider** uses TCP connections that work regardless of Unity's window state
- **Unity Profiler** uses UDP discovery and TCP streaming independent of the update loop
- **VS Code debugger** attaches via TCP and operates when Unity is minimized

Unity provides an official package implementing this pattern: **[com.unity.process-server](https://github.com/Unity-Technologies/com.unity.process-server)**. It runs external processes that survive domain reloads and uses IPC to stream output. Originally built for Unity's version control integration.

---

## Unity 6 specifics and the Awaitable class

Unity 6 introduced the `Awaitable` class for improved async/await integration:

```csharp
public async Awaitable DoWorkAsync()
{
    await Awaitable.BackgroundThreadAsync();  // Switch to background
    // Heavy computation here - CONTINUES when minimized
    
    await Awaitable.MainThreadAsync();  // Switch back to main
    // Unity API calls - WON'T resume until editor is un-minimized
}
```

This doesn't solve the minimized problem—`MainThreadAsync()` continuations wait for the next `Update` tick—but it provides cleaner syntax for the background thread pattern. Important: Unity doesn't automatically cancel background work when exiting Play mode; use `Application.exitCancellationToken` for cleanup.

No Unity 6 release notes mention changes to the minimized editor behavior. The throttling appears unchanged from previous versions.

---

## Command-line flags and editor settings

**Batch mode** (`-batchmode -nographics`) runs Unity without a window, eliminating the minimization issue entirely:

```batch
Unity.exe -batchmode -nographics -projectPath "C:\Project" -executeMethod MyClass.MyMethod
```

This works for automation and CI/CD but isn't viable for interactive development where you need the Editor UI.

**Editor Preferences → General → Interaction Mode** has a "No Throttling" option. This maintains higher CPU usage when unfocused but is still affected by minimize. Testing shows inconsistent results across platforms.

**Project Settings that don't help:**
- `Application.runInBackground` - Player builds only
- `PlayerSettings.visibleInBackground` - Player builds only
- `PlayerSettings.enableMetalAPIValidation` - rendering only, not update loop

No hidden registry keys or undocumented settings control this behavior.

---

## Win32 API approaches that don't work

Several Win32 APIs seem promising but fail to solve the core problem:

- **SetThreadExecutionState** - prevents system sleep/display off, doesn't affect Unity's internal throttling
- **SetPriorityClass** - changes CPU priority but not activation state
- **Window message hooks** - can detect WM_ACTIVATEAPP but can't prevent Unity's response to it
- **ShowWindow/IsIconic** - can detect and restore minimized state but doesn't prevent the pause

Unity's throttling happens at the application level inside its main loop, not at the OS level. External process manipulation can't override it.

---

## Community solutions and third-party packages

### MCP Unity for AI assistant integration

[MCP Unity](https://github.com/CoderGamester/mcp-unity) (1.1k stars) provides a WebSocket server in Unity Editor connecting to a Node.js MCP bridge. Tools include `execute_menu_item`, `select_gameobject`, `update_component`, scene queries, and console access.

**Known limitation:** The bridge connection drops during domain reloads. Workaround: disable "Reload Domain" in Project Settings.

**Minimized behavior:** ❌ WebSocket server runs in Unity, requires Update() processing.

### Unity Editor Tasks

[com.unity.editor.tasks](https://github.com/Unity-Technologies/com.unity.editor.tasks) provides TPL-based task management with custom schedulers. Useful for structuring background work but still depends on Unity's schedulers for UI dispatch.

### Third-party WebSocket packages

| Package | Server Support | Minimized? | Notes |
|---------|----------------|------------|-------|
| [NativeWebSocket](https://github.com/endel/NativeWebSocket) | Client only | ❌ | Requires Update() dispatch |
| [WebSocketSharp](https://github.com/sta/websocket-sharp) | ✅ Yes | ⚠️ Partial | Internal threads work |
| [Best HTTP/2](https://bestdocshub.pages.dev/) | ✅ Yes | ⚠️ Partial | Commercial, $44 |

### Named pipe wrappers

- [Lachee/unity-named-pipes](https://github.com/Lachee/unity-named-pipes) - recommended native wrapper
- [starburst997/Unity.IPC.NamedPipes](https://github.com/starburst997/Unity.IPC.NamedPipes) - alternative implementation

---

## The definitive solution matrix

| Approach | Runs minimized? | Real-time response? | Main thread access? |
|----------|-----------------|---------------------|---------------------|
| Background thread + TCP | ✅ Yes | ✅ Yes | Queued until active |
| Background thread + Named Pipes | ✅ Yes | ✅ Yes | Queued until active |
| Sidecar process | ✅ Yes | ✅ Yes | Via IPC when active |
| Batch mode | ✅ Yes | ✅ Yes | ✅ Yes (no GUI) |
| WebSocket in Unity | ❌ No | ❌ No | ❌ No |
| EditorApplication.update | ❌ No | ❌ No | N/A |
| Application.runInBackground | ❌ No (Editor) | N/A | N/A |

---

## Recommended implementation for Unity 6 on Windows

For real-time bidirectional communication that works when Unity is minimized:

1. **Run a TCP server on a background thread** inside Unity using `[InitializeOnLoad]` to start at editor launch

2. **Use a `ConcurrentQueue<Action>`** to dispatch work to the main thread via `EditorApplication.update`

3. **For external services requiring persistent connections**, run a sidecar process that maintains those connections and relays to Unity via named pipes or TCP

4. **Accept that main-thread Unity API calls will queue** until the editor is restored—design your protocol so the external service receives immediate acknowledgment of message receipt, with actual execution results delivered asynchronously

5. **For CI/CD and automation**, use batch mode to avoid the issue entirely

The fundamental constraint is architectural: Unity Editor's main thread pauses when minimized, and no workaround changes this. The solution is designing around it—keeping IPC responsive on background threads while gracefully handling the deferred main-thread execution.