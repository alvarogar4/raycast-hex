import { ActionPanel, List } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { inlineErrors, ReadError, RefreshAction } from "./feedback";
import { readStatus } from "./hex";

export default function Status() {
  const { data, error, isLoading, revalidate } = usePromise(readStatus, [], inlineErrors);
  if (error) return <ReadError error={error} retry={revalidate} />;
  const rows = data
    ? [
        ["Recording", [data.capture.state, data.capture.recording].filter(Boolean).join(" · ")],
        ["Pending Jobs", String(data.capture.pending_jobs)],
        ["Model", [data.model.name, data.model.language].join(" · ")],
        ...(data.model.preparing ? [["Preparing Model", data.model.preparing]] : []),
        ...(data.model.error ? [["Model Error", data.model.error]] : []),
        [
          "Meeting",
          [
            data.meeting.state,
            data.meeting.title,
            data.meeting.elapsed_seconds != null ? `${data.meeting.elapsed_seconds} s` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ],
      ]
    : [];
  return (
    <List isLoading={isLoading}>
      {rows.map(([key, value]) => (
        <List.Item
          key={key}
          title={key}
          subtitle={value}
          actions={
            <ActionPanel>
              <RefreshAction refresh={revalidate} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
