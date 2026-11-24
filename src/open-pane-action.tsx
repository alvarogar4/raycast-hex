import { Action, closeMainWindow, Icon } from "@raycast/api";
import { runControl } from "./feedback";

export function OpenPaneAction({ pane, title = "Open in Hex" }: { pane: "history" | "meetings"; title?: string }) {
  return (
    <Action
      title={title}
      icon={Icon.Window}
      onAction={async () => {
        if (await runControl(["window", "show"], ["--", pane])) await closeMainWindow();
      }}
    />
  );
}
