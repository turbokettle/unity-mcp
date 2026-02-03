import { z } from "zod";
import type { UnityConnection } from "../unity-connection.js";

export const executeMenuSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Menu item path (e.g., 'File/Save Scene', 'Assets/Refresh')"
    ),
});

export type ExecuteMenuInput = z.infer<typeof executeMenuSchema>;

interface ExecMenuResponse {
  success: boolean;
  message: string;
}

export async function executeMenu(
  unity: UnityConnection,
  input: ExecuteMenuInput
): Promise<string> {
  const response = await unity.send("exec_menu", {
    path: input.path,
  });

  if (!response.ok) {
    throw new Error(response.error || "Failed to execute menu item");
  }

  if (!response.data) {
    return `Executed menu item: ${input.path}`;
  }

  const data = JSON.parse(response.data) as ExecMenuResponse;

  if (!data.success) {
    throw new Error(data.message || `Failed to execute menu item: ${input.path}`);
  }

  return data.message;
}
