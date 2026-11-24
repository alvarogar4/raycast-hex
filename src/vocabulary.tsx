import { Action, ActionPanel, Form, Icon, List, useNavigation, Keyboard } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useState } from "react";
import { confirmDiscard, inlineErrors, ReadError, RefreshAction, runControl } from "./feedback";
import { readVocabulary } from "./hex";

function AddTerm({ existing = "", refresh }: { existing?: string; refresh: () => void }) {
  const { pop } = useNavigation();
  const [error, setError] = useState("");
  async function submit({ term, sounds }: { term: string; sounds: string }) {
    const name = existing || term.trim();
    if (!name) {
      setError("Enter a term.");
      return;
    }
    const args = sounds.trim() ? [`--sounds-like=${sounds.trim()}`] : [];
    if (await runControl(["vocabulary", "add"], [...args, "--", name])) {
      refresh();
      pop();
    }
  }
  return (
    <Form
      navigationTitle={existing ? "Add Spellings" : "Add Vocabulary Term"}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={existing ? "Add Spellings" : "Add Term"} onSubmit={submit} />
        </ActionPanel>
      }
    >
      {existing ? (
        <Form.Description title="Term" text={existing} />
      ) : (
        <Form.TextField id="term" title="Term" error={error || undefined} onChange={() => setError("")} />
      )}
      <Form.TextField id="sounds" title="Sounds Like" placeholder="Spellings separated by commas" />
    </Form>
  );
}

export default function Vocabulary() {
  const { data, error, isLoading, revalidate } = usePromise(readVocabulary, [], inlineErrors);
  if (error) return <ReadError error={error} retry={revalidate} />;
  const add = (
    <Action.Push
      title="Add Term"
      icon={Icon.Plus}
      shortcut={Keyboard.Shortcut.Common.New}
      target={<AddTerm refresh={revalidate} />}
    />
  );
  return (
    <List isLoading={isLoading} searchBarPlaceholder="Find a term or spelling…">
      <List.EmptyView title="No Matching Terms" actions={<ActionPanel>{add}</ActionPanel>} />
      {data?.entries.map(({ term, sounds_like }) => (
        <List.Item
          key={term}
          title={term}
          subtitle={sounds_like?.join(", ")}
          keywords={sounds_like}
          actions={
            <ActionPanel>
              <Action.Push title="Add Spellings" target={<AddTerm existing={term} refresh={revalidate} />} />
              {add}
              <Action
                title="Remove Term"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                onAction={async () => {
                  if (
                    await confirmDiscard(
                      `Remove “${term}”?`,
                      "This removes the term and all its sounds-like spellings.",
                      "Remove Term",
                    )
                  ) {
                    await runControl(["vocabulary", "remove"], ["--", term]);
                    revalidate();
                  }
                }}
              />
              <RefreshAction refresh={revalidate} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
