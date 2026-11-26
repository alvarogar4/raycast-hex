import { findNodeAtLocation, parseTree, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HistoryEntry } from "./hex";

// Darwin's O_EXLOCK takes the same flock as Hex's desktop::instance::acquire("listener").
const O_EXLOCK = 0x20;
// Darwin's O_SEARCH opens a directory for traversal. Syncing Trash needs no listing of other files.
const directorySyncFlags = process.platform === "darwin" ? 0x40100000 : constants.O_RDONLY;
export async function lockHistory(root: string) {
  if (process.platform !== "darwin") throw new Error("Moving transcripts to Trash requires macOS.");
  try {
    return await open(
      join(root, "listener.lock"),
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_EXLOCK,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EAGAIN") return undefined;
    throw new Error("Could not lock this Hex history folder.");
  }
}

// Caller holds Hex's instance lock through the archive, commit and recording cleanup.
export async function moveLockedTranscript(root: string, entry: HistoryEntry, trashDir = join(homedir(), ".Trash")) {
  const namespace = createHash("sha256").update(root).digest("hex").slice(0, 20);
  if (!(await lstat(trashDir)).isDirectory()) throw new Error("Expected the macOS Trash folder.");
  const history = join(root, "history.json");
  if (!(await lstat(history)).isFile()) throw new Error("Expected a regular Hex history file.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await readFile(history, { flag: constants.O_RDONLY | constants.O_NOFOLLOW }),
  );
  const { record, remaining, recordingBytes } = removeSelected(text, entry);
  const audio = await savedRecording(root, entry.id, recordingBytes);
  // Hex uses this same temporary for its next atomic save after a crash. A
  // private, separate snapshot of the other transcripts could outlive retention.
  const temporary = join(root, "history.json.tmp");
  await prepareReplacement(temporary, remaining);
  try {
    const archive = join(trashDir, `Hex Transcript ${entry.id} (${entry.timestamp_ms}-${namespace})`);
    const existing = await statIfPresent(archive);
    let generation: string;
    const conflict = new Error("The existing Trash archive differs. Move it aside in Finder and retry.");
    if (existing) {
      if (!existing.isDirectory()) throw conflict;
      generation = await archiveGeneration(archive, !!audio);
      for (const [name, expected] of [
        ["entry.json", record],
        ["transcript.txt", entry.final_text],
      ]) {
        const path = join(archive, name);
        if (!(await readFile(path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW })).equals(Buffer.from(expected)))
          throw conflict;
      }
      const saved = join(archive, "recording.wav");
      if (audio ? (await digest(audio)) !== (await digest(saved)) : await statIfPresent(saved)) throw conflict;
    } else {
      // An interrupted process leaves its partial archive recoverable in Finder.
      // Only this invocation cleans its own stage, while the originals are locked.
      const stage = await mkdtemp(join(trashDir, `Hex Transcript ${entry.id} (incomplete)-`));
      try {
        await writeFile(join(stage, "transcript.txt"), entry.final_text, { mode: 0o600, flush: true });
        await writeFile(join(stage, "entry.json"), record, { mode: 0o600, flush: true });
        if (audio) {
          const recording = join(stage, "recording.wav");
          await copyFile(audio, recording, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
          await syncPath(recording);
        }
        generation = await archiveGeneration(stage, !!audio);
        await syncPath(stage);
        await rename(stage, archive);
      } catch (error) {
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
    await syncPath(trashDir, directorySyncFlags);
    // Finder can edit an earlier archive while we compare a long recording.
    if ((await archiveGeneration(archive, !!audio)) !== generation) throw conflict;
    // If rename fails, both the live entry and its independent archive survive.
    try {
      await rename(temporary, history);
    } catch {
      throw new Error("A copy is in Trash. The transcript is still in Hex History.");
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  try {
    await syncPath(root);
  } catch {
    return "The archive is in Trash. The history folder could not be synced to disk.";
  }
  if (audio) {
    try {
      await unlink(audio);
    } catch {
      return "Hex will clean up the original recording on its next save.";
    }
  }
}

async function archiveGeneration(archive: string, audio: boolean) {
  const files = ["entry.json", "transcript.txt"];
  if (audio) files.push("recording.wav");
  const versions = await Promise.all(
    ["", ...files].map(async (name) => {
      const stat = await lstat(join(archive, name), { bigint: true });
      if (name ? !stat.isFile() : !stat.isDirectory()) throw new Error("Expected regular files in the Trash archive.");
      // Renaming the completed directory changes its ctime; the member files keep theirs.
      return name ? `${stat.dev}:${stat.ino}:${stat.ctimeNs}` : `${stat.dev}:${stat.ino}`;
    }),
  );
  return versions.join(",");
}

async function syncPath(path: string, flags: number = constants.O_RDONLY) {
  const handle = await open(path, flags | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function digest(path: string) {
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    for await (const chunk of input.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await input.close();
  }
}

async function prepareReplacement(temporary: string, remaining: string) {
  let flags = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL;
  const previous = await statIfPresent(temporary);
  if (previous) {
    // Reuse an interrupted write only if it adds no bytes absent from the
    // replacement. Preserve an unrelated unfinished Hex save.
    const error = new Error("Hex has an unfinished history save. Try again after Hex next saves history.");
    if (!previous.isFile() || previous.nlink !== 1 || (previous.mode & 0o777) !== 0o600) throw error;
    const prefix = await readFile(temporary, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
    if (!Buffer.from(remaining).subarray(0, prefix.length).equals(prefix)) throw error;
    flags = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_TRUNC;
  }
  const output = await open(temporary, flags, 0o600);
  try {
    await output.writeFile(remaining);
    await output.sync();
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    await output.close();
  }
}

async function savedRecording(root: string, id: number, recordedBytes: number) {
  // Hex can reuse an ID after a crash. A zero count does not claim a leftover WAV.
  if (recordedBytes === 0) return undefined;
  const folder = join(root, "history-audio");
  const dir = await statIfPresent(folder);
  if (dir && !dir.isDirectory()) throw new Error("Expected a regular Hex recordings folder.");
  const path = join(folder, `${id}.wav`);
  const file = dir && (await statIfPresent(path));
  if (file && !file.isFile()) throw new Error("Expected a regular Hex recording.");
  if (file?.size !== recordedBytes) throw new Error("The saved recording is missing or has changed.");
  return path;
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function removeSelected(text: string, selected: HistoryEntry) {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true });
  const entries = tree && findNodeAtLocation(tree, ["entries"]);
  if (
    errors.length ||
    !tree ||
    findNodeAtLocation(tree, ["version"])?.value !== 1 ||
    findNodeAtLocation(tree, ["next_id"])?.type !== "number" ||
    entries?.type !== "array" ||
    !entries.children
  ) {
    throw new Error("Unrecognized Hex history format.");
  }
  const rows = entries.children;
  const matches = rows.filter((row) => findNodeAtLocation(row, ["id"])?.value === selected.id);
  if (matches.length !== 1 || !Number.isSafeInteger(selected.id) || selected.id <= 0)
    throw new Error("Transcript is missing or ambiguous. Refresh History.");
  const row = matches[0];
  const record = text.slice(row.offset, row.offset + row.length);
  const stored = z
    .object({
      timestamp_ms: z.literal(selected.timestamp_ms),
      final_text: z.literal(selected.final_text),
      application: z.string().nullish(),
      raw_text: z.string(),
      recording_bytes: z.number().int().nonnegative().default(0),
    })
    .safeParse(JSON.parse(record));
  if (
    !stored.success ||
    (stored.data.application ?? null) !== selected.application ||
    stored.data.raw_text !== selected.raw_text
  ) {
    throw new Error("This transcript changed. Refresh History before moving it.");
  }
  // Remove only this array element and its comma. Preserve every other byte,
  // including u64 values that cannot round-trip through a JavaScript number.
  const index = rows.indexOf(row);
  const previous = rows[index - 1];
  const start = previous ? previous.offset + previous.length : row.offset;
  const end = !previous && rows[index + 1] ? rows[index + 1].offset : row.offset + row.length;
  return { record, remaining: text.slice(0, start) + text.slice(end), recordingBytes: stored.data.recording_bytes };
}
