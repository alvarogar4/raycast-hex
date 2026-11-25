import type { LaunchProps } from "@raycast/api";
import { runShortcut } from "./no-view";

export default function Command({ arguments: { title } }: LaunchProps<{ arguments: { title?: string } }>) {
  const meetingTitle = title?.trim();
  return runShortcut(["meetings", "record"], meetingTitle ? [`--title=${meetingTitle}`] : []);
}
