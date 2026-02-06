using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace UnityMCP
{
    /// <summary>
    /// Provides Win32 P/Invoke functionality to wake Unity's window when minimized.
    /// Unity's main thread pauses when the window is minimized, so we need to
    /// restore the window to ensure commands execute immediately.
    /// </summary>
    public static class WindowWaker
    {
        private const int SW_RESTORE = 9;
        private const int SW_MINIMIZE = 6;
        private const int SW_FORCEMINIMIZE = 11;

        private const uint WM_SYSCOMMAND = 0x0112;
        private const uint SC_MINIMIZE = 0xF020;

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        private static IntPtr _unityHwnd = IntPtr.Zero;
        private static IntPtr _previousForegroundWindow = IntPtr.Zero;
        private static volatile bool _wasMinimizedByUs = false;
        private static bool _initialized = false;

        /// <summary>
        /// Initialize the WindowWaker by capturing Unity's main window handle.
        /// Must be called from the main thread. Safe to call multiple times (for domain reloads).
        /// </summary>
        public static void Initialize()
        {
            try
            {
                // Always refresh the hwnd on initialize (handles domain reloads)
                var process = System.Diagnostics.Process.GetCurrentProcess();
                _unityHwnd = process.MainWindowHandle;

                // If MainWindowHandle is zero, try to find Unity window by title
                if (_unityHwnd == IntPtr.Zero)
                {
                    // Unity window title contains project name and "Unity"
                    Debug.LogWarning("[MCP] MainWindowHandle is zero, hwnd capture may have failed");
                }

                _initialized = true;
                _wasMinimizedByUs = false; // Reset state on domain reload
                _previousForegroundWindow = IntPtr.Zero;

                Debug.Log($"[MCP] WindowWaker initialized - hwnd: {_unityHwnd}, initialized: {_initialized}");
            }
            catch (Exception e)
            {
                Debug.LogError($"[MCP] Failed to initialize WindowWaker: {e.Message}");
                _initialized = false;
            }
        }

        /// <summary>
        /// Refresh the window handle. Call this if the handle becomes stale.
        /// </summary>
        public static void RefreshHandle()
        {
            try
            {
                var newHwnd = System.Diagnostics.Process.GetCurrentProcess().MainWindowHandle;
                if (newHwnd != IntPtr.Zero && newHwnd != _unityHwnd)
                {
                    Debug.Log($"[MCP] WindowWaker handle refreshed: {_unityHwnd} -> {newHwnd}");
                    _unityHwnd = newHwnd;
                }
            }
            catch (Exception e)
            {
                Debug.LogError($"[MCP] Failed to refresh window handle: {e.Message}");
            }
        }

        /// <summary>
        /// Check if Unity's window is currently minimized.
        /// </summary>
        public static bool IsMinimized()
        {
            if (_unityHwnd == IntPtr.Zero)
                return false;

            try
            {
                return IsIconic(_unityHwnd);
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Wake Unity's window if it's minimized. This forces the main thread to tick.
        /// Saves the current foreground window to restore later.
        /// </summary>
        /// <returns>True if the window was woken, false if it wasn't minimized or failed.</returns>
        public static bool WakeIfMinimized()
        {
            if (_unityHwnd == IntPtr.Zero)
            {
                Debug.LogWarning("[MCP] WindowWaker hwnd is zero, cannot wake window");
                return false;
            }

            try
            {
                bool isMinimized = IsIconic(_unityHwnd);
                Debug.Log($"[MCP] WakeIfMinimized - hwnd: {_unityHwnd}, IsIconic: {isMinimized}");

                if (isMinimized)
                {
                    // Save the current foreground window to restore later
                    var currentFg = GetForegroundWindow();
                    if (currentFg != _unityHwnd && currentFg != IntPtr.Zero)
                    {
                        _previousForegroundWindow = currentFg;
                        Debug.Log($"[MCP] Saved previous foreground window: {_previousForegroundWindow}");
                    }

                    Debug.Log("[MCP] Unity window is minimized, restoring...");
                    _wasMinimizedByUs = true;

                    bool result = ShowWindow(_unityHwnd, SW_RESTORE);
                    Debug.Log($"[MCP] ShowWindow(SW_RESTORE) returned: {result}");

                    return true;
                }
            }
            catch (Exception e)
            {
                Debug.LogError($"[MCP] Failed to wake window: {e.Message}");
            }

            return false;
        }

        /// <summary>
        /// Re-minimize the window if we previously woke it.
        /// Call this after command execution completes (from main thread).
        /// </summary>
        public static void RestoreMinimizedState()
        {
            if (!_wasMinimizedByUs)
            {
                Debug.Log("[MCP] RestoreMinimizedState called but _wasMinimizedByUs is false");
                return;
            }

            if (_unityHwnd == IntPtr.Zero)
            {
                Debug.LogWarning("[MCP] RestoreMinimizedState called but hwnd is zero");
                _wasMinimizedByUs = false;
                return;
            }

            try
            {
                _wasMinimizedByUs = false;

                Debug.Log($"[MCP] Attempting to re-minimize window {_unityHwnd}");

                // First restore focus to previous window (this helps minimize work)
                if (_previousForegroundWindow != IntPtr.Zero)
                {
                    bool fgResult = SetForegroundWindow(_previousForegroundWindow);
                    Debug.Log($"[MCP] SetForegroundWindow({_previousForegroundWindow}) returned: {fgResult}");
                }

                // Try multiple approaches to minimize
                // Approach 1: PostMessage with SC_MINIMIZE (async, more reliable)
                bool postResult = PostMessage(_unityHwnd, WM_SYSCOMMAND, (IntPtr)SC_MINIMIZE, IntPtr.Zero);
                Debug.Log($"[MCP] PostMessage(SC_MINIMIZE) returned: {postResult}");

                if (!postResult)
                {
                    // Approach 2: ShowWindow with SW_FORCEMINIMIZE
                    bool showResult = ShowWindow(_unityHwnd, SW_FORCEMINIMIZE);
                    Debug.Log($"[MCP] ShowWindow(SW_FORCEMINIMIZE) returned: {showResult}");

                    if (!showResult)
                    {
                        // Approach 3: Regular SW_MINIMIZE
                        showResult = ShowWindow(_unityHwnd, SW_MINIMIZE);
                        Debug.Log($"[MCP] ShowWindow(SW_MINIMIZE) returned: {showResult}");
                    }
                }

                _previousForegroundWindow = IntPtr.Zero;
                Debug.Log("[MCP] Re-minimize sequence completed");
            }
            catch (Exception e)
            {
                Debug.LogError($"[MCP] Failed to re-minimize window: {e.Message}");
                _wasMinimizedByUs = false;
                _previousForegroundWindow = IntPtr.Zero;
            }
        }

        /// <summary>
        /// Check if we should re-minimize after command completion.
        /// </summary>
        public static bool ShouldRestoreMinimized => _wasMinimizedByUs;

        /// <summary>
        /// Check if WindowWaker has been initialized with a valid handle.
        /// </summary>
        public static bool IsInitialized => _initialized && _unityHwnd != IntPtr.Zero;
    }
}
