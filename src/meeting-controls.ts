import { environment } from "@raycast/api";
import { runControl } from "./feedback";

export async function runMeetingControl(action: "record" | "stop", args: string[] = []) {
  await runControl(
    ["meetings", action],
    args,
    environment.commandMode !== "view",
    action === "stop" ? "No meeting is recording" : undefined,
  );
}
