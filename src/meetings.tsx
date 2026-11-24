import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { inlineErrors, ReadError, RefreshAction, runControl } from "./feedback";
import { readMeetings } from "./hex";
import { OpenPaneAction } from "./open-pane-action";

export default function Meetings() {
  const { data, error, isLoading, revalidate } = usePromise(readMeetings, [], inlineErrors);
  if (error) return <ReadError error={error} retry={revalidate} />;
  const actions = (
    <ActionPanel>
      <OpenPaneAction title="Open Meetings in Hex" pane="meetings" />
      <Action
        title="Start Meeting Recording"
        icon={Icon.Microphone}
        onAction={async () => {
          await runControl(["meetings", "record"]);
          revalidate();
        }}
      />
      <Action
        title="Stop and Transcribe Meeting"
        icon={Icon.Stop}
        onAction={async () => {
          await runControl(["meetings", "stop"]);
          revalidate();
        }}
      />
      <RefreshAction refresh={revalidate} />
    </ActionPanel>
  );
  return (
    <List isLoading={isLoading} searchBarPlaceholder="Find a meeting by title or app…">
      <List.EmptyView
        title="No Matching Meetings"
        description="Open Actions to start a recording or open Meetings in Hex."
        actions={actions}
      />
      <List.Section title="Recorded Meetings" subtitle={data?.truncated ? "Newest 200" : undefined}>
        {data?.meetings.map((meeting) => (
          <List.Item
            key={meeting.id}
            title={meeting.title || "Untitled Meeting"}
            subtitle={meeting.application ?? undefined}
            keywords={meeting.application ? [meeting.application] : []}
            accessories={[{ text: meeting.status }, { date: new Date(meeting.timestamp_ms) }]}
            actions={actions}
          />
        ))}
      </List.Section>
    </List>
  );
}
