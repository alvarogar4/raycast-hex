import { closeMainWindow } from "@raycast/api";
import { confirmDiscard, runControl } from "./feedback";
import { runMeetingControl } from "./meeting-controls";

export async function runShortcut(command: string[], args: string[] = []) {
  const [group, action] = command;
  if (
    action === "cancel" &&
    !(await confirmDiscard(
      "Discard the current dictation?",
      "Hex will discard the active recording.",
      "Discard Dictation",
    ))
  )
    return;
  await closeMainWindow();
  if (group === "meetings" && (action === "record" || action === "stop")) {
    return runMeetingControl(action, args);
  }
  await runControl(command, args, true);
}
