import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Icon,
  List,
  showHUD,
  showToast,
  Toast,
  Keyboard,
} from "@raycast/api";
import { HexStopped } from "./cli";
import { control } from "./hex";

// Errors are rendered inline. The default usePromise error handler also logs them.
export const inlineErrors = { onError: () => {} };

async function startHex(refresh?: () => void) {
  try {
    const reply = await control(["start"]);
    await showToast({ title: reply.message });
    refresh?.();
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: error instanceof Error ? error.message : "Could not start Hex",
    });
  }
}

export function ReadError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <List>
      <List.EmptyView
        icon={Icon.ExclamationMark}
        title={error.message}
        actions={
          <ActionPanel>
            {error instanceof HexStopped && <Action title="Start Hex" onAction={() => startHex(retry)} />}
            <Action title="Retry" icon={Icon.ArrowClockwise} onAction={retry} />
          </ActionPanel>
        }
      />
    </List>
  );
}

export async function runControl(command: string[], args: string[] = [], noView = false) {
  try {
    const reply = await control(command, args);
    if (noView) await showHUD(reply.message);
    else await showToast({ style: Toast.Style.Success, title: reply.message });
    return true;
  } catch (error) {
    await showHexError(error, noView);
    return false;
  }
}

export async function showHexError(error: unknown, noView = false) {
  const title = error instanceof Error ? error.message : "Hex command failed";
  if (error instanceof HexStopped && noView) {
    if (await confirmAlert({ title, primaryAction: { title: "Start Hex" } })) await startHex();
  } else {
    await showToast({
      style: Toast.Style.Failure,
      title,
      primaryAction: error instanceof HexStopped ? { title: "Start Hex", onAction: () => startHex() } : undefined,
    });
  }
}

export function confirmDiscard(title: string, message: string, action: string) {
  return confirmAlert({
    title,
    message,
    primaryAction: { title: action, style: Alert.ActionStyle.Destructive },
  });
}

export function RefreshAction({ refresh }: { refresh: () => void }) {
  return (
    <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={Keyboard.Shortcut.Common.Refresh} onAction={refresh} />
  );
}
