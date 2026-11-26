import { getPreferenceValues, showToast, Toast } from "@raycast/api";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { confirmDiscard, showHexError } from "./feedback";
import type { HistoryEntry } from "./hex";
import { lockHistory, moveLockedTranscript } from "./transcript-store";

export async function trashTranscript(entry: HistoryEntry): Promise<boolean> {
  const label = entry.final_text.trim().slice(0, 90) || "Empty dictation";
  const time = new Date(entry.timestamp_ms).toLocaleString();
  const confirmed = await confirmDiscard(
    "Move Transcript to Trash?",
    `#${entry.id} · ${time}\n“${label}”\nQuit Hex before confirming. Trash will contain the text and any saved recording.`,
    "Move to Trash",
  );
  if (!confirmed) return false;
  try {
    // Other builds, including Hex Test, can use a different history store.
    const installed = "/Applications/Hex.app/Contents/MacOS/hex";
    const { hexPath } = getPreferenceValues<{ hexPath: string }>();
    const path = await realpath(hexPath || installed);
    if (path !== (await realpath(installed))) throw new Error("Transcript Trash requires the installed Hex.app CLI.");
    const { stdout } = await promisify(execFile)(path, ["--version"]);
    if (!["hex 3.4.0", "hex 3.5.0"].includes(stdout.trim()))
      throw new Error("Transcript Trash supports Hex 3.4.0 and 3.5.0. Use Open in Hex for this version.");
    const support = process.env.HEX_APPLICATION_SUPPORT_DIR ?? join(homedir(), "Library/Application Support/hex");
    if (!isAbsolute(support)) throw new Error("Hex's history folder must be an absolute path.");
    const root = await realpath(support);
    const lock = await lockHistory(root);
    if (!lock) throw new Error("Hex history is in use. Quit Hex and retry ⌃K.");
    let detail;
    try {
      detail = await moveLockedTranscript(root, entry);
    } finally {
      await lock.close();
    }
    await showToast({ style: Toast.Style.Success, title: "Moved Transcript to Trash", message: detail });
    return true;
  } catch (error) {
    await showHexError(error);
    return false;
  }
}
