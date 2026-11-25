import { environment, launchCommand, LaunchType } from "@raycast/api";
import { runControl } from "./feedback";

export async function runMeetingControl(action: "record" | "stop", args: string[] = []) {
  try {
    await runControl(
      ["meetings", action],
      args,
      environment.commandMode !== "view",
      action === "stop" ? "No meeting is recording" : undefined,
    );
  } finally {
    if (environment.commandName !== "meeting-menu-bar") {
      // Raycast rejects the refresh when the menu bar command is disabled.
      await launchCommand({ name: "meeting-menu-bar", type: LaunchType.Background }).catch(() => {});
    }
  }
}
