import { Action, ActionPanel, Form, getPreferenceValues, Icon, List, useNavigation, Keyboard } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useRef, useState } from "react";
import { setTimeout as delay } from "node:timers/promises";
import { inlineErrors, ReadError, RefreshAction } from "./feedback";
import { readApps, readHistory } from "./hex";
import { OpenPaneAction } from "./open-pane-action";
import { trashTranscript } from "./trash-transcript";

const dates = [
  ["", "All Dates"],
  ["today", "Today"],
  ["3d", "Last 3 Days"],
  ["7d", "Last 7 Days"],
];
interface Filters {
  app: string;
  since: string;
}

function HistoryFilters({ value, apply }: { value: Filters; apply: (filters: Filters) => void }) {
  const { pop } = useNavigation();
  const [typed, setTyped] = useState("");
  const { data, isLoading, error, revalidate } = usePromise(readApps, [], inlineErrors);
  if (error) return <ReadError error={error} retry={revalidate} />;
  const apps = new Set([value.app, typed.trim(), ...(data ?? [])].filter(Boolean));
  return (
    <Form
      navigationTitle="Filter History"
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Apply Filters"
            onSubmit={(filters: Filters) => {
              apply(filters);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="app" title="Application" defaultValue={value.app} filtering onSearchTextChange={setTyped}>
        <Form.Dropdown.Item value="" title="All Applications" />
        {[...apps].map((app) => (
          <Form.Dropdown.Item key={app} value={app} title={app} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown id="since" title="Date" defaultValue={value.since}>
        {dates.map(([id, label]) => (
          <Form.Dropdown.Item key={id} value={id} title={label} />
        ))}
      </Form.Dropdown>
    </Form>
  );
}

// Indented Markdown renders arbitrary transcript text literally, including links and images.
function verbatim(value: string) {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) => "    " + line)
    .join("\n");
}

export default function SearchHistory() {
  const { allowTranscriptTrash } = getPreferenceValues<{ allowTranscriptTrash: boolean }>();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>({ app: "", since: "" });
  const [limit, setLimit] = useState(50);
  const abortable = useRef<AbortController | null>(null);
  const { data, isLoading, error, revalidate } = usePromise(
    async (text: string, app: string, since: string, limit: number) => {
      const signal = abortable.current?.signal;
      if (text) await delay(120, undefined, { signal });
      return readHistory(text, app, since, limit, signal);
    },
    [query, filters.app, filters.since, limit],
    { ...inlineErrors, abortable },
  );
  if (error) return <ReadError error={error} retry={revalidate} />;
  function apply(filters: Filters) {
    setFilters(filters);
    setLimit(50);
  }
  const filterAction = (
    <Action.Push
      title="Filter by Application and Date"
      icon={Icon.Filter}
      shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
      target={<HistoryFilters value={filters} apply={apply} />}
    />
  );
  const matched = data && data.query === query && data.app === filters.app && data.since === filters.since;
  const entries = matched ? data.entries : [];
  return (
    <List
      isLoading={isLoading}
      isShowingDetail={entries.length > 0}
      filtering={false}
      searchBarPlaceholder={filters.app ? `Search dictations in ${filters.app}` : "Search dictations…"}
      onSearchTextChange={(text) => {
        setQuery(text);
        setLimit(50);
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="Filter by Date"
          value={filters.since}
          onChange={(since) => apply({ ...filters, since })}
        >
          {dates.map(([value, title]) => (
            <List.Dropdown.Item key={value} value={value} title={title} />
          ))}
        </List.Dropdown>
      }
      pagination={{
        pageSize: 50,
        hasMore: !isLoading && !!matched && data.truncated && limit < 10000,
        onLoadMore: () => setLimit((n) => Math.min(n + 50, 10000)),
      }}
    >
      <List.EmptyView
        title={isLoading ? "Loading Dictations…" : "No Matching Dictations"}
        actions={
          <ActionPanel>
            {filterAction}
            <OpenPaneAction pane="history" />
            <RefreshAction refresh={revalidate} />
          </ActionPanel>
        }
      />
      {entries.map((entry) => {
        const app = entry.application || "Unknown Application";
        const time = new Date(entry.timestamp_ms).toLocaleString();
        return (
          <List.Item
            key={entry.id}
            id={String(entry.id)}
            title={entry.final_text.split(/\r?\n/).find(Boolean)?.slice(0, 120) || "(Empty dictation)"}
            subtitle={app}
            accessories={[{ text: time }]}
            detail={
              <List.Item.Detail
                markdown={`## Final Text\n\n${verbatim(entry.final_text)}\n\n## Raw Transcript\n\n${verbatim(entry.raw_text ?? "Unavailable")}`}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="Application" text={app} />
                    <List.Item.Detail.Metadata.Label title="Recorded" text={time} />
                    <List.Item.Detail.Metadata.Label title="Transcript ID" text={String(entry.id)} />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard
                  concealed
                  title={allowTranscriptTrash ? "Trash ⌃K  ·  Copy Dictation" : "Copy Dictation"}
                  content={entry.final_text}
                  shortcut={{ modifiers: ["cmd"], key: "c" }}
                />
                <Action.Paste title="Paste Dictation" content={entry.final_text} />
                {entry.raw_text != null && (
                  <Action.CopyToClipboard
                    concealed
                    title="Copy Raw Transcript"
                    content={entry.raw_text}
                    shortcut={Keyboard.Shortcut.Common.Copy}
                  />
                )}
                <OpenPaneAction pane="history" />
                {filterAction}
                <RefreshAction refresh={revalidate} />
                {allowTranscriptTrash && (
                  <Action
                    title="Move Transcript to Trash"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["ctrl"], key: "k" }}
                    onAction={async () => {
                      if (await trashTranscript(entry)) revalidate();
                    }}
                  />
                )}
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
