import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  readdirSync,
  rmSync,
  existsSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { lockHistory, moveLockedTranscript as moveToTrash } from "../src/transcript-store";

vi.mock("node:fs/promises", { spy: true });
const temp = mkdtempSync(join(tmpdir(), "hex-transcript-tests-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
afterEach(() => vi.clearAllMocks());

const entry = { id: 12, timestamp_ms: 101, application: null, final_text: "keep this [text]", raw_text: "keep  this" };
const stored = { ...entry, application: undefined, versions: [{ final_text: "older version" }] };
const sibling =
  '{"id":88,"timestamp_ms":110,"kind":"dictation","raw_text":"x","final_text":"x","extra":18446744073709551612}';

function fixture(records = [sibling, JSON.stringify(stored)]) {
  const root = mkdtempSync(join(temp, "case-"));
  const history = join(root, "history.json");
  const source = `{"version":1,"next_id":18446744073709551614,"entries":[${records.join(",\n")}]}`;
  writeFileSync(history, source);
  writeFileSync(join(root, "listener.lock"), "");
  const directory = join(root, "Trash");
  mkdirSync(directory);
  const namespace = createHash("sha256").update(root).digest("hex").slice(0, 20);
  const archived = join(directory, `Hex Transcript 12 (101-${namespace})`);
  return { root, history, source, archived };
}

function moveLockedTranscript(root: string, selected: typeof entry) {
  return moveToTrash(root, selected, join(root, "Trash"));
}

const selected = JSON.stringify(stored);
it.each([
  ["first", [selected, sibling]],
  ["middle", [sibling, selected, '{"id":44}']],
  ["last", [sibling, selected]],
  ["only", [selected]],
] as const)("moves the %s entry, preserving siblings and exact u64 values", async (position, records) => {
  const { root, history, archived } = fixture([...records]);
  await moveLockedTranscript(root, entry);
  expect(readFileSync(history, "utf8")).toContain('"next_id":18446744073709551614');
  if (position !== "only") expect(readFileSync(history, "utf8")).toContain(sibling);
  expect(JSON.parse(readFileSync(history, "utf8")).entries.map((e: { id: number }) => e.id)).toEqual(
    records.filter((r) => r !== selected).map((r) => JSON.parse(r).id),
  );
  expect(statSync(history).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(archived, "transcript.txt"), "utf8")).toBe(entry.final_text);
  expect(readFileSync(join(archived, "entry.json"), "utf8")).toBe(selected);
  await expect(moveLockedTranscript(root, entry)).rejects.toThrow(/missing/);
  expect(readdirSync(join(root, "Trash"))).toHaveLength(1);
});

it("retains the selected recording in Trash and leaves the sibling audio in place", async () => {
  const { root, archived } = fixture([JSON.stringify({ ...stored, recording_bytes: 5 }), sibling]);
  const audio = join(root, "history-audio");
  mkdirSync(audio);
  writeFileSync(join(audio, "12.wav"), "audio");
  writeFileSync(join(audio, "88.wav"), "other");
  await moveLockedTranscript(root, entry);
  expect(readFileSync(join(archived, "recording.wav"), "utf8")).toBe("audio");
  expect(existsSync(join(audio, "12.wav"))).toBe(false);
  expect(readFileSync(join(audio, "88.wav"), "utf8")).toBe("other");
});

it("keeps history and audio intact if macOS Trash fails", async () => {
  const { root, history, source } = fixture([JSON.stringify({ ...stored, recording_bytes: 5 })]);
  mkdirSync(join(root, "history-audio"));
  writeFileSync(join(root, "history-audio/12.wav"), "audio");
  vi.mocked(rename).mockRejectedValueOnce(new Error("Trash is unavailable"));
  await expect(moveLockedTranscript(root, entry)).rejects.toThrow(/Trash is unavailable/);
  expect(readFileSync(history, "utf8")).toBe(source);
  expect(readFileSync(join(root, "history-audio/12.wav"), "utf8")).toBe("audio");
});

it.each([
  [JSON.stringify({ ...stored, timestamp_ms: 8 })],
  [JSON.stringify({ ...stored, final_text: "edited" })],
  [JSON.stringify({ ...stored, raw_text: "new raw" })],
  [JSON.stringify({ ...stored, application: "Other" })],
  [JSON.stringify(stored) + "," + JSON.stringify(stored)],
  ['{"id":44}'],
  ["{} garbage"],
])("refuses a changed, missing, duplicate or malformed selection", async (record) => {
  const { root, history, source } = fixture([record]);
  await expect(moveLockedTranscript(root, entry)).rejects.toThrow();
  expect(readFileSync(history, "utf8")).toBe(source);
  expect(readdirSync(join(root, "Trash"))).toEqual([]);
});

it("rejects a symlinked recordings folder before archiving anything", async () => {
  const { root, history, source } = fixture([JSON.stringify({ ...stored, recording_bytes: 5 })]);
  symlinkSync(temp, join(root, "history-audio"));
  await expect(moveLockedTranscript(root, entry)).rejects.toThrow(/regular Hex recordings/);
  expect(readFileSync(history, "utf8")).toBe(source);
  expect(readdirSync(join(root, "Trash"))).toEqual([]);
});

it("excludes competing opens and releases the lock after close on macOS", async () => {
  const { root } = fixture();
  if (process.platform === "darwin") {
    const first = await lockHistory(root);
    expect(first).toBeDefined();
    expect(await lockHistory(root)).toBeUndefined();
    await first?.close();
    const retry = await lockHistory(root);
    expect(retry).toBeDefined();
    await retry?.close();
  } else {
    await expect(lockHistory(root)).rejects.toThrow(/macOS/);
  }
});

it("leaves an unclaimed WAV for Hex after an interrupted save", async () => {
  const { root, archived } = fixture();
  mkdirSync(join(root, "history-audio"));
  writeFileSync(join(root, "history-audio/12.wav"), "old audio");
  await moveLockedTranscript(root, entry);
  expect(existsSync(join(archived, "recording.wav"))).toBe(false);
  expect(readFileSync(join(root, "history-audio/12.wav"), "utf8")).toBe("old audio");
});

it("a failed commit leaves live history and audio independent of the Trash copy", async () => {
  const { root, archived, history, source } = fixture([JSON.stringify({ ...stored, recording_bytes: 4 }), sibling]);
  mkdirSync(join(root, "history-audio"));
  writeFileSync(join(root, "history-audio/12.wav"), "live");
  vi.mocked(rename)
    .mockImplementationOnce(async (from, to) => renameSync(from, to))
    .mockRejectedValueOnce(new Error("cannot commit"));
  await expect(moveLockedTranscript(root, entry)).rejects.toThrow(/copy is in Trash/);
  expect(readFileSync(history, "utf8")).toBe(source);
  expect(existsSync(join(root, "history.json.tmp"))).toBe(false);
  writeFileSync(join(archived, "recording.wav"), "edit");
  expect(readFileSync(join(root, "history-audio/12.wav"), "utf8")).toBe("live");
  await expect(moveLockedTranscript(root, entry)).rejects.toThrow(/existing Trash archive differs/);
  expect(readFileSync(history, "utf8")).toBe(source);
  writeFileSync(join(archived, "recording.wav"), "live");
  const inode = statSync(archived).ino;
  await moveLockedTranscript(root, entry);
  expect(statSync(archived).ino).toBe(inode);
  expect(readdirSync(join(root, "Trash"))).toHaveLength(1);
  expect(readFileSync(join(archived, "recording.wav"), "utf8")).toBe("live");
  expect(readFileSync(history, "utf8")).not.toContain(entry.final_text);
});

it("reports a committed move even if removing the original audio fails", async () => {
  const { root, archived, history } = fixture([JSON.stringify({ ...stored, recording_bytes: 5 }), sibling]);
  mkdirSync(join(root, "history-audio"));
  writeFileSync(join(root, "history-audio/12.wav"), "audio");
  vi.mocked(unlink).mockRejectedValueOnce(new Error("audio busy"));
  expect(await moveLockedTranscript(root, entry)).toMatch(/next save/);
  expect(readFileSync(join(archived, "recording.wav"), "utf8")).toBe("audio");
  expect(readFileSync(history, "utf8")).not.toContain(entry.final_text);
});

it("preserves an earlier unfinished Hex save", async () => {
  const { root, history, source } = fixture();
  const temporary = join(root, "history.json.tmp");
  writeFileSync(temporary, "prior save");
  await expect(moveLockedTranscript(root, entry)).rejects.toThrow();
  expect(readFileSync(temporary, "utf8")).toBe("prior save");
  expect(readFileSync(history, "utf8")).toBe(source);
  expect(readdirSync(join(root, "Trash"))).toEqual([]);
});

it.each([8, Infinity])("retries a replacement interrupted after %s bytes", async (length) => {
  const { root, history, source, archived } = fixture();
  const remaining = source.replace(",\n" + JSON.stringify(stored), "");
  writeFileSync(join(root, "history.json.tmp"), remaining.slice(0, length), { mode: 0o600 });
  await moveLockedTranscript(root, entry);
  expect(readFileSync(history, "utf8")).toBe(remaining);
  expect(readFileSync(join(archived, "transcript.txt"), "utf8")).toBe(entry.final_text);
});

it.each([true, false])(
  "preserves a previous interrupted copy even after Hex retention (row present %s)",
  async (present) => {
    const { root } = fixture(present ? [sibling, selected] : [sibling]);
    const interrupted = join(root, "Trash", "Hex Transcript 12 (incomplete)-previous");
    mkdirSync(interrupted);
    writeFileSync(join(interrupted, "recording.wav"), "only surviving recording");
    if (present) await moveLockedTranscript(root, entry);
    else await expect(moveLockedTranscript(root, entry)).rejects.toThrow(/missing/);
    expect(readFileSync(join(interrupted, "recording.wav"), "utf8")).toBe("only surviving recording");
  },
);

it("requires a successful sync even when a retry found a complete replacement", async () => {
  const { root, history, source } = fixture();
  const temporary = join(root, "history.json.tmp");
  writeFileSync(temporary, source.replace(",\n" + JSON.stringify(stored), ""), { mode: 0o600 });
  const output = await open(temporary, "r+");
  vi.spyOn(output, "sync").mockRejectedValueOnce(new Error("could not sync"));
  vi.mocked(open).mockResolvedValueOnce(output);
  await expect(moveLockedTranscript(root, entry)).rejects.toThrow(/could not sync/);
  expect(readdirSync(join(root, "Trash"))).toEqual([]);
  expect(readFileSync(history, "utf8")).toBe(source);
});

it.each(["entry.json", "transcript.txt"])(
  "preserves the live entry when a previous archive's %s changed",
  async (name) => {
    const { root, archived, history, source } = fixture();
    vi.mocked(rename)
      .mockImplementationOnce(async (from, to) => renameSync(from, to))
      .mockRejectedValueOnce(new Error("save failed"));
    await expect(moveLockedTranscript(root, entry)).rejects.toThrow(/copy is in Trash/);
    writeFileSync(join(archived, name), "edited in Finder");
    await expect(moveLockedTranscript(root, entry)).rejects.toThrow(/archive differs/);
    expect(readFileSync(history, "utf8")).toBe(source);
    expect(readFileSync(join(archived, name), "utf8")).toBe("edited in Finder");
    expect(readdirSync(join(root, "Trash"))).toHaveLength(1);
  },
);

it("recreates the recovery copy when the user empties Trash before retrying", async () => {
  const { root, archived, history } = fixture();
  vi.mocked(rename)
    .mockImplementationOnce(async (from, to) => renameSync(from, to))
    .mockRejectedValueOnce(new Error("save failed"));
  await expect(moveLockedTranscript(root, entry)).rejects.toThrow(/copy is in Trash/);
  rmSync(archived, { recursive: true });
  await moveLockedTranscript(root, entry);
  expect(readFileSync(join(archived, "entry.json"), "utf8")).toBe(selected);
  expect(readFileSync(history, "utf8")).not.toContain(entry.final_text);
});

it("leaves a symlinked archive and its target alone", async () => {
  const { root, archived, history, source } = fixture();
  symlinkSync(root, archived);
  await expect(moveLockedTranscript(root, entry)).rejects.toThrow(/archive differs/);
  expect(readFileSync(history, "utf8")).toBe(source);
  expect(existsSync(archived)).toBe(true);
});

it("retains the live row if Finder changes the archive during the recording comparison", async () => {
  const { root, archived, history, source } = fixture([JSON.stringify({ ...stored, recording_bytes: 4 }), sibling]);
  const live = join(root, "history-audio/12.wav");
  mkdirSync(join(root, "history-audio"));
  writeFileSync(live, "live");
  vi.mocked(rename)
    .mockImplementationOnce(async (from, to) => renameSync(from, to))
    .mockRejectedValueOnce(new Error("save failed"));
  await expect(moveLockedTranscript(root, entry)).rejects.toThrow(/copy is in Trash/);
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await vi.mocked(open).withImplementation(
    async (path, flags, mode) => {
      if (path === live) rmSync(join(archived, "entry.json"));
      return original.open(path, flags, mode);
    },
    async () => {
      await expect(moveLockedTranscript(root, entry)).rejects.toThrow();
    },
  );
  expect(readFileSync(history, "utf8")).toBe(source);
  expect(readFileSync(live, "utf8")).toBe("live");
});

it("preserves live history and recording if the Trash directory cannot be synced", async () => {
  const { root, history, source } = fixture([JSON.stringify({ ...stored, recording_bytes: 4 }), sibling]);
  mkdirSync(join(root, "history-audio"));
  const live = join(root, "history-audio/12.wav");
  writeFileSync(live, "live");
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await vi.mocked(open).withImplementation(
    async (path, flags, mode) => {
      const handle = await original.open(path, flags, mode);
      if (path === join(root, "Trash"))
        vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("directory sync failed"));
      return handle;
    },
    async () => {
      await expect(moveLockedTranscript(root, entry)).rejects.toThrow(/directory sync failed/);
    },
  );
  expect(readFileSync(history, "utf8")).toBe(source);
  expect(readFileSync(live, "utf8")).toBe("live");
  await moveLockedTranscript(root, entry);
  expect(readdirSync(join(root, "Trash"))).toHaveLength(1);
});
