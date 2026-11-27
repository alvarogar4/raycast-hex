import { Action, ActionPanel, Form, useNavigation } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import type { Meeting } from "./hex";
import { renameMeeting } from "./meeting-title";

export function RenameMeetingForm({ meeting, refresh }: { meeting: Meeting; refresh: () => void }) {
  const { pop } = useNavigation();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
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
      await renameMeeting(meeting, name, save.signal);
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
        defaultValue={meeting.title}
        autoFocus
        error={error}
        onChange={() => setError(undefined)}
      />
    </Form>
  );
}
