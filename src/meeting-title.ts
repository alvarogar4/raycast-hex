import { confirmAlert, getPreferenceValues } from "@raycast/api";
import { applyEdits, modify } from "jsonc-parser/lib/esm/main.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { HexStopped } from "./cli";
import { control, type Meeting, readMeetings, readStatus } from "./hex";
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

export async function renameMeeting(selected: Meeting, title: string, signal: AbortSignal) {
  const name = title.trim();
  if (!name) throw new Error("Enter a meeting title.");
  if (!selected.id || selected.id === "." || selected.id === ".." || /[\\/\0]/.test(selected.id))
    throw new Error("Invalid Hex meeting ID.");
  const support = process.env.HEX_APPLICATION_SUPPORT_DIR ?? join(homedir(), "Library/Application Support/hex");
  if (!isAbsolute(support)) throw new Error("Hex’s meetings folder must be an absolute path.");
  const installed = "/Applications/Hex.app/Contents/MacOS/hex";
  const { hexPath } = getPreferenceValues<{ hexPath: string }>();
  if (hexPath && hexPath !== installed && (await realpath(hexPath)) !== (await realpath(installed)))
    throw new Error("Rename Meeting requires the installed Hex.app CLI.");
  const root = await realpath(support);
  const instance = await lockForRename(root, signal);
  if (!instance) return false;
  try {
    await writeTitle(root, selected, name, signal);
    return true;
  } finally {
    await instance.close();
  }
}

async function lockForRename(root: string, signal: AbortSignal) {
  const lock = await lockHistory(root);
  if (lock) return lock;
  if (await hexIsIdle()) {
    signal.throwIfAborted();
    const confirmed = await confirmAlert({
      title: "Quit Hex and Save?",
      message:
        "Hex must close to rename the recording. Save any open work in Hex first. You can reopen Hex after saving.",
      primaryAction: { title: "Quit Hex and Save" },
    });
    if (!confirmed) return;
    if (await hexIsIdle()) {
      signal.throwIfAborted();
      await control(["quit"]).catch((error) => {
        if (!(error instanceof HexStopped)) throw error;
      });
    }
  }
  // Hex acknowledges quit before releasing its instance lock.
  for (let attempt = 0; attempt < 30; attempt++) {
    await setTimeout(100, undefined, { signal });
    const lock = await lockHistory(root);
    if (lock) return lock;
  }
  throw new Error("Hex’s recording library is still in use. Try saving again.");
}

async function hexIsIdle() {
  const status = await readStatus().catch((error) => {
    if (!(error instanceof HexStopped)) throw error;
  });
  if (!status) return false;
  if (
    status.meeting.state !== "idle" ||
    status.capture.state !== "idle" ||
    status.capture.recording !== null ||
    status.capture.pending_jobs !== 0 ||
    status.model.preparing !== null
  )
    throw new Error("Wait for Hex to finish recording or processing, then save again.");
  return true;
}

async function writeTitle(root: string, selected: Meeting, name: string, signal: AbortSignal) {
  const directory = join(root, "meetings", selected.id);
  if ((await realpath(directory)) !== directory) throw new Error("The meeting folder is a symbolic link.");
  const path = join(directory, "manifest.json");
  const read = () => readFile(path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW, encoding: "utf8" });
  const original = await read();
  const stored = manifest.safeParse(JSON.parse(original));
  if (!stored.success || stored.data.id !== selected.id || stored.data.created_at_ms !== selected.timestamp_ms)
    throw new Error("This recording is busy or its format has changed.");
  const { meetings } = await readMeetings();
  const current = meetings.find((meeting) => meeting.id === selected.id);
  if (
    !current ||
    current.in_progress ||
    current.timestamp_ms !== selected.timestamp_ms ||
    current.title !== selected.title
  )
    throw new Error(changed);
  if (stored.data.title === name && stored.data.title_source === "user") return;

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
    if ((await read()) !== original) throw new Error(changed);
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
