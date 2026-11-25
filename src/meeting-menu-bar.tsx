import { Color, Icon, MenuBarExtra } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { inlineErrors, runControl } from "./feedback";
import { readStatus } from "./hex";
import { runMeetingControl } from "./meeting-controls";

function elapsedTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

export default function MeetingMenuBar() {
  const { data, error, isLoading, revalidate } = usePromise(readStatus, [], inlineErrors);
  if (isLoading) return <MenuBarExtra isLoading />;
  if (error || data?.meeting.state !== "recording") return null;

  const { title, elapsed_seconds } = data.meeting;
  return (
    <MenuBarExtra
      icon={{ source: Icon.CircleFilled, tintColor: Color.Red }}
      title={elapsed_seconds == null ? undefined : elapsedTime(elapsed_seconds)}
    >
      <MenuBarExtra.Section title={title || "Untitled Meeting"}>
        <MenuBarExtra.Item
          title="Stop & Transcribe"
          icon={Icon.Stop}
          onAction={() => runMeetingControl("stop").finally(revalidate)}
        />
        <MenuBarExtra.Item
          title="Open Meetings in Hex"
          icon={Icon.Window}
          onAction={() => runControl(["window", "show"], ["--", "meetings"], true)}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
