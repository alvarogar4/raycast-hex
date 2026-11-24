import { runShortcut } from "./no-view";

export default function Command() {
  return runShortcut(["dictation", "stop"]);
}
