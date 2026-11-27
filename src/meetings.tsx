import { Action, ActionPanel, Icon, Keyboard, List } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { inlineErrors, ReadError, RefreshAction } from "./feedback";
import type { Meeting } from "./hex";
import { canRenameMeeting, listRecordings } from "./meeting-title";
import { runMeetingControl } from "./meeting-controls";
import { OpenPaneAction } from "./open-pane-action";
import { RenameMeetingForm } from "./rename-meeting";
import { trashMeeting } from "./trash-meeting";

export default function Meetings() {
  const { data, error, isLoading, revalidate } = usePromise(listRecordings, [], inlineErrors);
  if (error) return <ReadError error={error} retry={revalidate} />;
  const actions = (meeting?: Meeting) => (
    <ActionPanel>
      <OpenPaneAction title="Open Meetings in Hex" pane="meetings" />
      <Action
        title="Start Meeting Recording"
        icon={Icon.Microphone}
        onAction={async () => {
          await runMeetingControl("record");
          revalidate();
        }}
      />
      <Action
        title="Stop and Transcribe Meeting"
        icon={Icon.Stop}
        onAction={async () => {
          await runMeetingControl("stop");
          revalidate();
        }}
      />
      {data?.library && meeting && canRenameMeeting(meeting) && (
        <Action.Push
          title="Rename Meeting"
          icon={Icon.Pencil}
          shortcut={Keyboard.Shortcut.Common.Edit}
          target={<RenameMeetingForm meeting={meeting} refresh={revalidate} library={data.library} />}
        />
      )}
      <RefreshAction refresh={revalidate} />
      {meeting && (
        <ActionPanel.Section>
          <Action
            title="Move Meeting to Trash"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            shortcut={{ modifiers: ["ctrl"], key: "k" }}
            onAction={async () => {
              if (await trashMeeting(meeting)) revalidate();
            }}
          />
        </ActionPanel.Section>
      )}
    </ActionPanel>
  );
  return (
    <List isLoading={isLoading} searchBarPlaceholder="Find a meeting by title or app…">
      <List.EmptyView
        title="No Matching Meetings"
        description="Open Actions to start a recording or open Meetings in Hex."
        actions={actions()}
      />
      <List.Section title="Recorded Meetings" subtitle={data?.truncated ? "Newest 200" : undefined}>
        {data?.meetings.map((meeting) => (
          <List.Item
            key={meeting.id}
            title={meeting.title || "Untitled Meeting"}
            subtitle={meeting.application ?? undefined}
            keywords={meeting.application ? [meeting.application] : []}
            accessories={[{ text: meeting.status }, { date: new Date(meeting.timestamp_ms) }]}
            actions={actions(meeting)}
          />
        ))}
      </List.Section>
    </List>
  );
}
