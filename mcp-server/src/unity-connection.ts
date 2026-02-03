import * as net from "net";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";

export interface MCPRequest {
  id: string;
  cmd: string;
  params?: string; // JSON string
}

export interface MCPResponse {
  id: string;
  ok: boolean;
  data?: string; // JSON string
  error?: string;
}

interface PendingRequest {
  resolve: (response: MCPResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * TCP client for communicating with Unity's MCP server.
 */
export class UnityConnection extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = "";
  private pendingRequests = new Map<string, PendingRequest>();
  private connected = false;
  private reconnecting = false;

  private port: number;
  private host: string;
  private defaultTimeout: number;

  constructor(port: number, host = "127.0.0.1", defaultTimeout = 30000) {
    super();
    this.port = port;
    this.host = host;
    this.defaultTimeout = defaultTimeout;
  }

  /**
   * Connect to the Unity MCP server.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      const onError = (err: Error) => {
        this.cleanup();
        reject(err);
      };

      this.socket.once("error", onError);

      this.socket.connect(this.port, this.host, () => {
        this.socket!.removeListener("error", onError);
        this.connected = true;
        this.setupSocketHandlers();
        console.error(`[MCP] Connected to Unity at ${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  private setupSocketHandlers(): void {
    if (!this.socket) return;

    this.socket.on("data", (data) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.socket.on("close", () => {
      console.error("[MCP] Connection to Unity closed");
      this.cleanup();
      this.emit("close");
    });

    this.socket.on("error", (err) => {
      console.error(`[MCP] Socket error: ${err.message}`);
      this.cleanup();
      this.emit("error", err);
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line) as MCPResponse;
        this.handleResponse(response);
      } catch (e) {
        console.error(`[MCP] Failed to parse response: ${e}`);
      }
    }
  }

  private handleResponse(response: MCPResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.error(`[MCP] Received response for unknown request: ${response.id}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);
    pending.resolve(response);
  }

  private cleanup(): void {
    this.connected = false;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  /**
   * Send a command to Unity and wait for response.
   */
  async send(
    cmd: string,
    params?: Record<string, unknown>,
    timeout?: number
  ): Promise<MCPResponse> {
    if (!this.connected || !this.socket) {
      throw new Error("Not connected to Unity");
    }

    const id = randomUUID();
    const request: MCPRequest = {
      id,
      cmd,
      params: params ? JSON.stringify(params) : undefined,
    };

    return new Promise((resolve, reject) => {
      const timeoutMs = timeout ?? this.defaultTimeout;
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeout: timeoutHandle,
      });

      const json = JSON.stringify(request) + "\n";
      this.socket!.write(json, (err) => {
        if (err) {
          clearTimeout(timeoutHandle);
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Send a ping to verify connection.
   */
  async ping(): Promise<boolean> {
    try {
      const response = await this.send("ping", undefined, 5000);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Disconnect from Unity.
   */
  disconnect(): void {
    this.cleanup();
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
