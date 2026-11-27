import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecordings, renameMeeting, type MeetingLibrary } from "../src/meeting-title";
import { readMeetings, renameWithHex, resolveHexExecutable, supportsMeetingRename, type Meeting } from "../src/hex";
import { HexStopped } from "../src/cli";
import { withLibraryAccess } from "../src/library-access";

vi.mock("@raycast/api", () => ({
  environment: {
    get supportPath() {
      return temp;
    },
  },
}));
vi.mock("../src/hex", () => ({
  readMeetings: vi.fn(),
  resolveHexExecutable: vi.fn(),
  supportsMeetingRename: vi.fn(),
  renameWithHex: vi.fn(),
}));
const temp = await mkdtemp(join(tmpdir(), "raycast-title-"));
afterAll(() => rm(temp, { recursive: true, force: true }));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
const signal = new AbortController().signal;
let library: MeetingLibrary;
const selected: Meeting = {
  id: "123-1",
  timestamp_ms: 123,
  status: "complete",
  title: "Generated title",
  in_progress: false,
  application: null,
};

async function fixture() {
  const root = await mkdtemp(join(temp, "hex-"));
  vi.stubEnv("HEX_APPLICATION_SUPPORT_DIR", root);
  library = { root: await realpath(root), executable: "/Applications/Hex.app/Contents/MacOS/hex" };
  vi.mocked(resolveHexExecutable).mockResolvedValue(library.executable);
  await writeFile(join(root, "listener.lock"), "");
  const dir = join(root, "meetings", selected.id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "manifest.json");
  const original =
    '{"schema_version":1,"id":"123-1","created_at_ms":123,"status":"complete","title":"Default","notes":{"title":"Generated title"},"samples":18446744073709551615}';
  await writeFile(path, original);
  vi.mocked(readMeetings).mockResolvedValue({ meetings: [selected], truncated: false, version: 1 });
  vi.mocked(supportsMeetingRename).mockResolvedValue(false);
  return { dir, path, original, root };
}

it("sets a user title in the actual manifest and preserves unrelated fields and integer precision", async () => {
  const { path } = await fixture();
  await renameMeeting(selected, '  --review "Monday" ☕  ', signal, library);
  const text = await readFile(path, "utf8");
  expect(JSON.parse(text)).toMatchObject({
    title: '--review "Monday" ☕',
    title_source: "user",
    notes: { title: "Generated title" },
  });
  expect(text).toContain('"samples":18446744073709551615');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it.each(["pending", "active", "deleted", "retitled", "format", "modified"])(
  "refuses a %s recording without publishing a title",
  async (reason) => {
    const { dir, path, original } = await fixture();
    let expected = original;
    switch (reason) {
      case "pending":
        await writeFile(join(dir, "final.pending"), "");
        break;
      case "active":
        vi.mocked(readMeetings).mockResolvedValueOnce({
          version: 1,
          truncated: false,
          meetings: [{ ...selected, in_progress: true }],
        });
        break;
      case "deleted":
        vi.mocked(readMeetings).mockResolvedValueOnce({ version: 1, truncated: false, meetings: [] });
        break;
      case "retitled":
        vi.mocked(readMeetings).mockResolvedValueOnce({
          version: 1,
          truncated: false,
          meetings: [{ ...selected, title: "Different" }],
        });
        break;
      case "format":
        expected = original.replace('"schema_version":1', '"schema_version":2');
        await writeFile(path, expected);
        break;
      case "modified":
        expected = original.replace('"Default"', '"Another update"');
        vi.mocked(readMeetings).mockImplementationOnce(async () => {
          await writeFile(path, expected);
          return { version: 1, truncated: false, meetings: [selected] };
        });
        break;
    }
    await expect(renameMeeting(selected, "new", signal, library)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(expected);
  },
);

it("honors the native active.lock even after a successful list read", async () => {
  const { dir, path, original } = await fixture();
  const lock = await open(
    join(dir, "active.lock"),
    constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | 0x20,
    0o600,
  );
  try {
    await expect(renameMeeting(selected, "Busy", signal, library)).rejects.toThrow("using this recording");
    expect(await readFile(path, "utf8")).toBe(original);
  } finally {
    await lock.close();
  }
});

it("refuses meeting folder redirects", async () => {
  const { dir, root } = await fixture();
  await symlink(dir, join(root, "meetings", "alias"));
  await expect(renameMeeting({ ...selected, id: "alias" }, "Different", signal, library)).rejects.toThrow(
    "symbolic link",
  );
});

it("leaves native notes intact while Hex owns the instance lock and allows saving once it releases the lock", async () => {
  const { root, path, original } = await fixture();
  const native = await open(join(root, "listener.lock"), constants.O_RDWR | constants.O_NONBLOCK | 0x20);
  try {
    await expect(renameMeeting(selected, "New title", signal, library)).rejects.toThrow("no live rename command");
    expect(renameWithHex).not.toHaveBeenCalled();
    await writeFile(path, original.replace('"Generated title"', '"New notes"'));
  } finally {
    await native.close();
  }
  await renameMeeting(selected, "New title", signal, library);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ title: "New title", notes: { title: "New notes" } });
});

it("persists a generated title when the user explicitly saves it", async () => {
  const { path } = await fixture();
  await renameMeeting(selected, selected.title, signal, library);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ title: selected.title, title_source: "user" });
});

it("dispatches a supported live rename while Hex owns the library", async () => {
  const { root, path, original } = await fixture();
  const native = await open(join(root, "listener.lock"), constants.O_RDWR | constants.O_NONBLOCK | 0x20);
  vi.mocked(supportsMeetingRename).mockResolvedValue(true);
  try {
    await renameMeeting(selected, "  Live edit  ", signal, library);
    expect(renameWithHex).toHaveBeenCalledExactlyOnceWith(library.executable, selected.id, "Live edit", library.root);
    expect(await readFile(path, "utf8")).toBe(original);
  } finally {
    await native.close();
  }
});

it.each([new Error("Hex is finishing meeting notes."), new HexStopped(), new Error("Invalid reply")])(
  "never falls back to a file write after a native error: %s",
  async (error) => {
    const { root, path, original } = await fixture();
    const native = await open(join(root, "listener.lock"), constants.O_RDWR | constants.O_NONBLOCK | 0x20);
    vi.mocked(supportsMeetingRename).mockResolvedValue(true);
    vi.mocked(renameWithHex).mockImplementationOnce(async () => {
      await native.close();
      throw error;
    });
    try {
      await expect(renameMeeting(selected, "Live edit", signal, library)).rejects.toThrow(error.message);
      expect(await readFile(path, "utf8")).toBe(original);
    } finally {
      await native.close();
    }
  },
);

it("saves in the selected offline library even if it contains a copied discovery file", async () => {
  const { root, path } = await fixture();
  await writeFile(join(root, "local-api.json"), JSON.stringify({ pid: process.pid, port: 41234 }));
  vi.mocked(supportsMeetingRename).mockResolvedValue(true);
  await renameMeeting(selected, "Offline edit", signal, library);
  expect(renameWithHex).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ title: "Offline edit", title_source: "user" });
});

it("rejects a switched CLI before sending the selected recording ID", async () => {
  await fixture();
  vi.mocked(resolveHexExecutable).mockResolvedValueOnce("/other/profile/hex");
  await expect(renameMeeting(selected, "Wrong profile", signal, library)).rejects.toThrow("library changed");
  expect(renameWithHex).not.toHaveBeenCalled();
});

it("serializes live saves and rejects an edit that has gone stale in the meantime", async () => {
  const { root } = await fixture();
  const native = await open(join(root, "listener.lock"), constants.O_RDWR | constants.O_NONBLOCK | 0x20);
  vi.mocked(supportsMeetingRename).mockResolvedValue(true);
  vi.mocked(renameWithHex).mockImplementationOnce(async () => {
    await expect(renameMeeting(selected, "Second", signal, library)).rejects.toThrow(
      "Another Raycast library operation",
    );
    vi.mocked(readMeetings).mockResolvedValue({
      version: 1,
      truncated: false,
      meetings: [{ ...selected, title: "First" }],
    });
    return { version: 4, status: "done", message: "Renamed", changed: true };
  });
  try {
    await renameMeeting(selected, "First", signal, library);
    await expect(renameMeeting(selected, "Second", signal, library)).rejects.toThrow("meeting changed");
    expect(renameWithHex).toHaveBeenCalledOnce();
  } finally {
    await native.close();
  }
});

it("can save a draft opened during transcription once the current recording is finished", async () => {
  const { path, original } = await fixture();
  const transcribing = { ...selected, status: "transcribing", in_progress: true, title: "Provisional title" };
  vi.mocked(readMeetings).mockResolvedValueOnce({ version: 1, meetings: [transcribing], truncated: false });
  await expect(renameMeeting(transcribing, "My draft", signal, library)).rejects.toThrow("transcription");
  expect(await readFile(path, "utf8")).toBe(original);
  await renameMeeting(transcribing, "My draft", signal, library);
  expect(JSON.parse(await readFile(path, "utf8")).title).toBe("My draft");
});

it.each([undefined, "user"])("preserves a competing user rename with title_source %s", async (source) => {
  const { path, original } = await fixture();
  const transcribing = { ...selected, status: "transcribing", in_progress: true, title: "Provisional title" };
  const updated = JSON.stringify({ ...JSON.parse(original), title: "Edited in Hex", title_source: source });
  await writeFile(path, updated);
  vi.mocked(readMeetings).mockResolvedValueOnce({
    version: 1,
    truncated: false,
    meetings: [{ ...selected, title: "Edited in Hex" }],
  });
  await expect(renameMeeting(transcribing, "My draft", signal, library)).rejects.toThrow("meeting changed");
  expect(await readFile(path, "utf8")).toBe(updated);
});

it("leaves the manifest intact after cancellation", async () => {
  const { path, original } = await fixture();
  await expect(renameMeeting(selected, "New title", AbortSignal.abort(), library)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(original);
});

it("keeps the selected library bound to the recording when the configured folder switches", async () => {
  const first = await fixture();
  const selection = await listRecordings();
  const second = await fixture();
  expect(selection.library?.root).toBe(await realpath(first.root));
  await expect(renameMeeting(selected, "Another title", signal, selection.library!)).rejects.toThrow("library changed");
  expect(await readFile(first.path, "utf8")).toBe(first.original);
  expect(await readFile(second.path, "utf8")).toBe(second.original);
});

it("rejects malformed UTF-8 without replacing bytes in unrelated fields", async () => {
  const { path, original } = await fixture();
  const invalid = Buffer.concat([
    Buffer.from(original.slice(0, -1) + ',"extra":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  await writeFile(path, invalid);
  await expect(renameMeeting(selected, "New title", signal, library)).rejects.toThrow();
  expect(await readFile(path)).toEqual(invalid);
});

it("does not dispatch to Hex when another Raycast operation owns the offline library", async () => {
  const { root } = await fixture();
  vi.mocked(supportsMeetingRename).mockResolvedValue(true);
  await withLibraryAccess(root, async (offline) => {
    expect(offline).toBe(true);
    await expect(renameMeeting(selected, "Wrong library", signal, library)).rejects.toThrow(
      "Another Raycast library operation",
    );
  });
  expect(renameWithHex).not.toHaveBeenCalled();
});

it("cancels the selection read and releases the operation lock before dispatch", async () => {
  const { root } = await fixture();
  const native = await open(join(root, "listener.lock"), constants.O_RDWR | constants.O_NONBLOCK | 0x20);
  const edit = new AbortController();
  vi.mocked(supportsMeetingRename).mockResolvedValue(true);
  vi.mocked(readMeetings).mockImplementationOnce(async (_root, _executable, preflight) => {
    expect(preflight).toBe(edit.signal);
    edit.abort();
    return Promise.reject(edit.signal.reason);
  });
  try {
    await expect(renameMeeting(selected, "Cancelled", edit.signal, library)).rejects.toThrow();
    expect(renameWithHex).not.toHaveBeenCalled();
    await renameMeeting(selected, "Next edit", signal, library);
    expect(renameWithHex).toHaveBeenCalledOnce();
  } finally {
    await native.close();
  }
});
