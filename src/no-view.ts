import { closeMainWindow } from "@raycast/api";
import { confirmDiscard, runControl } from "./feedback";

export async function runShortcut(command: string[]) {
  if (
    command[1] === "cancel" &&
    !(await confirmDiscard(
      "Discard the current dictation?",
      "Hex will discard the active recording.",
      "Discard Dictation",
    ))
  )
    return;
  await closeMainWindow();
  await runControl(command, [], true);
}
