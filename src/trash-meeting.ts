import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { confirmDiscard, runControl, showHexError } from "./feedback";
import { type Meeting, readMeetings } from "./hex";

async function currentMeeting(selected: Meeting) {
  const { meetings } = await readMeetings();
  const current = meetings.find(({ id }) => id === selected.id);
  if (!current || current.timestamp_ms !== selected.timestamp_ms)
    throw new Error("This meeting changed. Refresh Meetings and try again.");
  if (current.in_progress) throw new Error("Wait for this meeting to finish.");
  return current;
}

// The native CLI also trashes whatever is currently at these saved export paths.
async function exportPaths(id: string) {
  if (!id || id === "." || id === ".." || /[\\/\0]/.test(id)) throw new Error("Invalid Hex meeting ID.");
  const support = process.env.HEX_APPLICATION_SUPPORT_DIR ?? join(homedir(), "Library/Application Support/hex");
  if (!isAbsolute(support)) throw new Error("Hex's meetings folder must be an absolute path.");
  const path = join(support, "meetings", id, "manifest.json");
  const file = z.string().refine(isAbsolute).nullish();
  const manifest = z.object({ id: z.literal(id), export_path: file, notes_export_path: file });
  try {
    const { export_path, notes_export_path } = manifest.parse(JSON.parse(await readFile(path, "utf8")));
    return [export_path, notes_export_path].filter((value): value is string => !!value);
  } catch {
    throw new Error("Could not verify this meeting’s export paths. Use the Meetings pane in Hex.");
  }
}

export async function trashMeeting(selected: Meeting): Promise<boolean> {
  try {
    const meeting = await currentMeeting(selected);
    const title = meeting.title || "Untitled Meeting";
    const time = new Date(meeting.timestamp_ms).toLocaleString();
    const paths = await exportPaths(meeting.id);
    const exports = paths.length
      ? `\nHex will also trash any files at these paths, including edited or replaced files:\n${paths.join("\n")}`
      : "";
    const confirmed = await confirmDiscard(
      "Move Meeting to Trash?",
      `“${title}” (${time})\nHex will trash this meeting folder.${exports}`,
      "Move to Trash",
    );
    if (!confirmed) return false;
    const current = await currentMeeting(meeting);
    const currentPaths = await exportPaths(current.id);
    if (
      current.title !== meeting.title ||
      paths.length !== currentPaths.length ||
      paths.some((path, i) => path !== currentPaths[i])
    )
      throw new Error("This meeting changed. Refresh Meetings and try again.");
    return await runControl(["meetings", "delete"], ["--", meeting.id]);
  } catch (error) {
    await showHexError(error);
    return false;
  }
}
