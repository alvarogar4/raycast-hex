import { environment } from "@raycast/api";
import { applyEdits, modify } from "jsonc-parser/lib/esm/main.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { type Meeting, readMeetings, renameWithHex, resolveHexExecutable, supportsMeetingRename } from "./hex";
import { lockHistory } from "./transcript-store";

const manifest = z.object({
  schema_version: z.literal(1),
  id: z.string(),
  created_at_ms: z.number(),
  title: z.string(),
  title_source: z.string().nullish(),
  status: z.enum(["starting", "recording", "transcribing", "complete", "interrupted", "failed"]),
});
const changed = "This meeting changed. Reopen Rename Meeting to edit its current title.";

// Hex's recorder and recovery use flock on this same file. Darwin open(2) can take it atomically.
const O_EXLOCK = 0x20;

function libraryPath() {
  const support = process.env.HEX_APPLICATION_SUPPORT_DIR ?? join(homedir(), "Library/Application Support/hex");
  return isAbsolute(support) ? realpath(support).catch(() => undefined) : undefined;
}

export type MeetingLibrary = { root: string; executable: string };

export async function listRecordings() {
  const [root, executable] = await Promise.all([libraryPath(), resolveHexExecutable()]);
  return { ...(await readMeetings(root, executable)), library: root ? { root, executable } : undefined };
}

export function canRenameMeeting(meeting: Meeting) {
  return !meeting.in_progress && ["complete", "interrupted", "failed"].includes(meeting.status);
}

export async function renameMeeting(selected: Meeting, title: string, signal: AbortSignal, library: MeetingLibrary) {
  const name = title.trim();
  if (!name) throw new Error("Enter a meeting title.");
  if (!selected.id || selected.id === "." || selected.id === ".." || /[\\/\0]/.test(selected.id))
    throw new Error("Invalid Hex meeting ID.");
  const { root, executable } = library;
  if ((await libraryPath()) !== root || (await resolveHexExecutable()) !== executable)
    throw new Error("The Hex library changed. Reopen Meetings and try again.");
  signal.throwIfAborted();
  const instance = await lockHistory(root);
  if (instance) {
    try {
      const installed = "/Applications/Hex.app/Contents/MacOS/hex";
      if (executable !== installed && executable !== (await realpath(installed)))
        throw new Error("Offline rename requires the installed Hex.app CLI.");
      await writeTitle(library, selected, name, signal);
    } finally {
      await instance.close();
    }
    return;
  }
  if (!(await supportsMeetingRename(executable, signal)))
    throw new Error("This Hex CLI has no live rename command. Save after Hex closes.");
  // Hold this across the selection check and reply so two Raycast saves can't both pass on the old title.
  const request = await open(
    join(environment.supportPath, "meeting-rename.lock"),
    constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW | O_EXLOCK,
    0o600,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EAGAIN") throw new Error("Another rename is in progress. Try saving again.");
    throw error;
  });
  try {
    await verifySelection(library, selected);
    signal.throwIfAborted();
    // After dispatch, dismissing the form cannot cancel the operation inside Hex.
    await renameWithHex(executable, selected.id, name, root);
  } finally {
    await request.close();
  }
}

async function readSnapshot(root: string, selected: Meeting) {
  const directory = join(root, "meetings", selected.id);
  if ((await realpath(directory)) !== directory) throw new Error("The meeting folder is a symbolic link.");
  const path = join(directory, "manifest.json");
  const read = () => readFile(path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
  const bytes = await read();
  const original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const stored = manifest.safeParse(JSON.parse(original));
  if (!stored.success || stored.data.id !== selected.id || stored.data.created_at_ms !== selected.timestamp_ms)
    throw new Error("This recording is busy or its format has changed.");
  return { directory, path, read, bytes, original, data: stored.data };
}

async function verifySelection(library: MeetingLibrary, selected: Meeting, stored?: z.infer<typeof manifest>) {
  const { root, executable } = library;
  const { meetings } = await readMeetings(root, executable);
  const current = meetings.find((meeting) => meeting.id === selected.id);
  if (!current || current.timestamp_ms !== selected.timestamp_ms) throw new Error(changed);
  if (!canRenameMeeting(current)) throw new Error("Wait for recording and transcription to finish, then save again.");
  if (current.title !== selected.title) {
    if (canRenameMeeting(selected)) throw new Error(changed);
    const data = stored ?? (await readSnapshot(root, selected)).data;
    const source = data.title_source;
    // Hex returns a user-provided title verbatim, including on recordings that predate title_source.
    const generated = source == null ? current.title !== data.title : ["default", "call", "calendar"].includes(source);
    if (!generated) throw new Error(changed);
  }
}

async function writeTitle(library: MeetingLibrary, selected: Meeting, name: string, signal: AbortSignal) {
  const { root } = library;
  const { directory, path, read, bytes, original, data } = await readSnapshot(root, selected);
  await verifySelection(library, selected, data);
  if (data.title === name && data.title_source === "user") return;

  const lock = await open(
    join(directory, "active.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_EXLOCK,
    0o600,
  ).catch(() => {
    throw new Error("Hex is using this recording. Try again when it finishes.");
  });
  const temporary = join(directory, `.raycast-title-${randomUUID()}.tmp`);
  try {
    if (
      await lstat(join(directory, "final.pending")).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      })
    )
      throw new Error("Wait for Hex to finish transcribing this meeting.");
    // Patch only these values. Re-serializing the manifest would round large audio counters.
    const renamed = applyEdits(original, modify(original, ["title"], name, {}));
    const next = applyEdits(renamed, modify(renamed, ["title_source"], "user", {}));
    await writeFile(temporary, next, { mode: 0o600, flag: "wx", flush: true });
    if (!(await read()).equals(bytes) || (await libraryPath()) !== root) throw new Error(changed);
    signal.throwIfAborted();
    await rename(temporary, path);
    const folder = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  } finally {
    try {
      await rm(temporary, { force: true });
    } finally {
      await lock.close();
    }
  }
}
