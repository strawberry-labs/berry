import type { Message, Task } from "@berry/shared";
import type { SignedInUser } from "@/components/shell/auth-boundary";
import type { WebConfig } from "./config";
import { fixtureMessages, fixtureTasks } from "./fixtures";

export interface ShellData {
  config: WebConfig;
  tasks: Task[];
  messages: Message[];
  user: SignedInUser | null;
  sessionResolved: boolean;
}

export function loadFixtureShellData(
  config: WebConfig,
  user: SignedInUser | null = null,
  sessionResolved = config.demoMode,
): ShellData {
  const tasks = fixtureTasks();
  return {
    config,
    tasks,
    messages: fixtureMessages(tasks[0]?.activeSessionId ?? "session_cloud"),
    user,
    sessionResolved,
  };
}
