import { z } from "zod";
import type { UnityConnection } from "../unity-connection.js";

export const readLogsSchema = z.object({
  count: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(50)
    .describe("Number of log entries to retrieve (1-1000)"),
  filter: z
    .enum(["all", "errors", "warnings"])
    .optional()
    .default("all")
    .describe("Filter logs by type"),
});

export type ReadLogsInput = z.infer<typeof readLogsSchema>;

interface LogEntry {
  message: string;
  stackTrace: string;
  type: string;
  timestamp: string;
}

interface LogsResponse {
  logs: LogEntry[];
}

function formatLogEntry(entry: LogEntry): string {
  const icon =
    entry.type === "Error" || entry.type === "Exception"
      ? "[ERROR]"
      : entry.type === "Warning"
        ? "[WARN]"
        : "[LOG]";

  let text = `${entry.timestamp} ${icon} ${entry.message}`;

  if (
    entry.stackTrace &&
    (entry.type === "Error" || entry.type === "Exception")
  ) {
    text += `\n  Stack trace:\n  ${entry.stackTrace.replace(/\n/g, "\n  ")}`;
  }

  return text;
}

export async function readLogs(
  unity: UnityConnection,
  input: ReadLogsInput
): Promise<string> {
  const response = await unity.send("get_logs", {
    count: input.count,
    filter: input.filter,
  });

  if (!response.ok) {
    throw new Error(response.error || "Failed to read logs");
  }

  if (!response.data) {
    return "No logs available.";
  }

  const data = JSON.parse(response.data) as LogsResponse;

  if (!data.logs || data.logs.length === 0) {
    return "No logs available.";
  }

  const formattedLogs = data.logs.map(formatLogEntry).join("\n\n");

  return `Unity Console Logs (${data.logs.length} entries):\n\n${formattedLogs}`;
}
