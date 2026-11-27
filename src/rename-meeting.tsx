import { Action, ActionPanel, Form, useNavigation } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import type { Meeting } from "./hex";
import { canRenameMeeting, renameMeeting } from "./meeting-title";

export function RenameMeetingForm({
  meeting,
  refresh,
  library,
}: {
  meeting: Meeting;
  refresh: () => void;
  library: string;
}) {
  const { pop } = useNavigation();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(meeting.title);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function submit({ title }: { title: string }) {
    if (pending.current) return;
    const name = title.trim();
    if (!name) {
      setError("Enter a meeting title.");
      return;
    }
    const save = new AbortController();
    pending.current = save;
    setSaving(true);
    try {
      await renameMeeting(meeting, name, save.signal, library);
      refresh();
      if (!save.signal.aborted) pop();
    } catch (error) {
      if (!save.signal.aborted) {
        refresh();
        setError(error instanceof Error ? error.message : "Could not rename this meeting.");
      }
    } finally {
      pending.current = null;
      if (!save.signal.aborted) setSaving(false);
    }
  }

  return (
    <Form
      navigationTitle="Rename Meeting"
      isLoading={saving}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Title" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="Meeting Title"
        value={draft}
        autoFocus
        error={error}
        onChange={(text) => {
          if (pending.current) return;
          setDraft(text);
          setError(undefined);
        }}
      />
      {!canRenameMeeting(meeting) && (
        <Form.Description text="You can edit the title now. Once recording and transcription finish, quit Hex and save." />
      )}
    </Form>
  );
}
