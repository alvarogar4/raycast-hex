import { Action, ActionPanel, Form, Icon, List, showToast, useNavigation } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useState } from "react";
import { confirmDiscard, inlineErrors, ReadError, RefreshAction, runControl, showHexError } from "./feedback";
import { readSettings, type Setting } from "./hex";

function valueText(value: Setting["value"]) {
  if (value === null) return "none";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function SettingForm({ setting, refresh }: { setting: Setting; refresh: () => void }) {
  const { pop } = useNavigation();
  const [error, setError] = useState("");
  const isJson = setting.kind === "json";
  const initial = valueText(setting.value);
  const options =
    setting.kind === "bool"
      ? ["true", "false"]
      : setting.choices
        ? [...new Set([...setting.choices, "none", initial])]
        : undefined;
  async function submit({ value }: { value: string }) {
    if (isJson) {
      try {
        JSON.parse(value);
      } catch {
        setError("Enter valid JSON.");
        return;
      }
    }
    if (value === initial) {
      pop();
      return;
    }
    if (isJson || /retention|^capture\.(bundle|media)_days$|^labs\.expire_meeting_audio$/.test(setting.key)) {
      const message = isJson
        ? "This replaces the full stored JSON value."
        : "Changing retention can expire existing recordings or transcripts.";
      if (!(await confirmDiscard(`Change ${setting.key}?`, message, "Save Setting"))) return;
    }
    // A second Hex window, shortcut or another Raycast command can edit the same setting.
    let latest: Setting | undefined;
    try {
      latest = (await readSettings(setting.key)).settings.find((s) => s.key === setting.key);
    } catch (error) {
      await showHexError(error);
      refresh();
      pop();
      return;
    }
    if (!latest?.available || !latest.writable || valueText(latest.value) !== initial) {
      await showToast({
        title: "This setting changed. Reopen it to edit the current value.",
      });
      refresh();
      pop();
      return;
    }
    if (await runControl(["settings", "set"], ["--", setting.key, value])) {
      refresh();
      pop();
    }
  }
  return (
    <Form
      navigationTitle={setting.key}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Setting" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description title={setting.key} text={setting.about} />
      {options ? (
        <Form.Dropdown id="value" title="Value" defaultValue={initial}>
          {options.map((option) => (
            <Form.Dropdown.Item key={option} title={option} value={option} />
          ))}
        </Form.Dropdown>
      ) : isJson ? (
        <Form.TextArea
          id="value"
          title="JSON"
          defaultValue={initial}
          error={error || undefined}
          onChange={() => setError("")}
        />
      ) : (
        <Form.TextField
          id="value"
          title={setting.key === "microphone" ? "Device Name" : "Value"}
          defaultValue={initial}
        />
      )}
    </Form>
  );
}

const microphones = ["microphone", "avoid_bluetooth_microphone", "release_microphone_while_idle"];

export function SettingsList({ microphoneOnly = false }: { microphoneOnly?: boolean }) {
  const { data, error, isLoading, revalidate } = usePromise(readSettings, [], inlineErrors);
  if (error) return <ReadError error={error} retry={revalidate} />;
  const settings = microphoneOnly
    ? microphones.flatMap((key) => data?.settings.filter((s) => s.key === key) ?? [])
    : data?.settings;
  return (
    <List isLoading={isLoading} isShowingDetail searchBarPlaceholder="Find a setting…">
      {settings?.map((setting) => {
        const editable = setting.writable && setting.available;
        return (
          <List.Item
            key={setting.key}
            title={setting.key}
            keywords={[setting.about]}
            icon={editable ? Icon.Gear : Icon.Lock}
            detail={
              <List.Item.Detail
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="Description" text={setting.about} />
                    <List.Item.Detail.Metadata.Label title="Value" text={valueText(setting.value)} />
                    <List.Item.Detail.Metadata.Label title="Type" text={setting.kind} />
                    <List.Item.Detail.Metadata.Label
                      title="Access"
                      text={!setting.available ? "Unavailable on this Mac" : editable ? "Editable" : "Read-only"}
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                {editable && (
                  <Action.Push title="Edit Setting" target={<SettingForm setting={setting} refresh={revalidate} />} />
                )}
                <RefreshAction refresh={revalidate} />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}

export default function Settings() {
  return <SettingsList />;
}
