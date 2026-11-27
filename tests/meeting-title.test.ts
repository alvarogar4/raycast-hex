import { afterAll, afterEach, expect, it, vi } from "vitest";
import { confirmAlert } from "@raycast/api";
import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameMeeting } from "../src/meeting-title";
import { control, readMeetings, readStatus, type Meeting } from "../src/hex";

vi.mock("@raycast/api", () => ({ confirmAlert: vi.fn(), getPreferenceValues: () => ({}) }));
vi.mock("../src/hex", () => ({ readMeetings: vi.fn(), control: vi.fn(), readStatus: vi.fn() }));
const temp = await mkdtemp(join(tmpdir(), "raycast-title-"));
afterAll(() => rm(temp, { recursive: true, force: true }));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
const signal = new AbortController().signal;
const idle = {
  version: 4,
  status: "status",
  capture: { state: "idle", recording: null, pending_jobs: 0 },
  meeting: { state: "idle", title: null, elapsed_seconds: null },
  model: { id: "", name: "", language: "", preparing: null, error: null },
} as const;
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
  await writeFile(join(root, "listener.lock"), "");
  const dir = join(root, "meetings", selected.id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "manifest.json");
  const original =
    '{"schema_version":1,"id":"123-1","created_at_ms":123,"status":"complete","title":"Default","notes":{"title":"Generated title"},"samples":18446744073709551615}';
  await writeFile(path, original);
  vi.mocked(readMeetings).mockResolvedValue({ meetings: [selected], truncated: false, version: 1 });
  return { dir, path, original, root };
}

it("sets a user title in the actual manifest and preserves unrelated fields and integer precision", async () => {
  const { path } = await fixture();
  await renameMeeting(selected, '  --review "Monday" ☕  ', signal);
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
    await expect(renameMeeting(selected, "new", signal)).rejects.toThrow();
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
    await expect(renameMeeting(selected, "Busy", signal)).rejects.toThrow("using this recording");
    expect(await readFile(path, "utf8")).toBe(original);
  } finally {
    await lock.close();
  }
});

it("refuses meeting folder redirects", async () => {
  const { dir, root } = await fixture();
  await symlink(dir, join(root, "meetings", "alias"));
  await expect(renameMeeting({ ...selected, id: "alias" }, "Different", signal)).rejects.toThrow("symbolic link");
});

it("leaves native notes intact while Hex owns the instance lock and allows saving once it releases the lock", async () => {
  const { root, path, original } = await fixture();
  const native = await open(join(root, "listener.lock"), constants.O_RDWR | constants.O_NONBLOCK | 0x20);
  try {
    vi.mocked(readStatus).mockResolvedValue({ ...idle, meeting: { ...idle.meeting, state: "recording" } });
    await expect(renameMeeting(selected, "New title", signal)).rejects.toThrow("Wait for Hex");
    expect(confirmAlert).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
    await writeFile(path, original.replace('"Generated title"', '"New notes"'));
  } finally {
    await native.close();
  }
  await renameMeeting(selected, "New title", signal);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ title: "New title", notes: { title: "New notes" } });
});

it("waits for a confirmed idle Hex to release its lock before committing the title", async () => {
  const { root, path } = await fixture();
  const native = await open(join(root, "listener.lock"), constants.O_RDWR | constants.O_NONBLOCK | 0x20);
  try {
    vi.mocked(readStatus).mockResolvedValue(idle);
    vi.mocked(confirmAlert).mockResolvedValue(true);
    vi.mocked(control).mockImplementationOnce(async () => {
      setTimeout(() => void native.close(), 150);
      return { version: 4, status: "done", message: "Quitting Hex", changed: true };
    });
    await expect(renameMeeting(selected, "Saved in Raycast", signal)).resolves.toBe(true);
    expect(confirmAlert).toHaveBeenCalledOnce();
    expect(control).toHaveBeenCalledExactlyOnceWith(["quit"]);
    expect(JSON.parse(await readFile(path, "utf8")).title).toBe("Saved in Raycast");
  } finally {
    await native.close();
  }
});

it.each(["cancelled", "started dictation", "dismissed form"])("does not quit after %s", async (reason) => {
  const { root, path, original } = await fixture();
  const native = await open(join(root, "listener.lock"), constants.O_RDWR | constants.O_NONBLOCK | 0x20);
  const save = new AbortController();
  try {
    vi.mocked(readStatus).mockResolvedValue(idle);
    vi.mocked(confirmAlert).mockImplementationOnce(async () => {
      if (reason === "started dictation")
        vi.mocked(readStatus).mockResolvedValue({ ...idle, capture: { ...idle.capture, pending_jobs: 1 } });
      if (reason === "dismissed form") save.abort();
      return reason !== "cancelled";
    });
    const result = renameMeeting(selected, "Another title", save.signal);
    if (reason === "cancelled") await expect(result).resolves.toBe(false);
    else await expect(result).rejects.toThrow();
    expect(control).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(original);
  } finally {
    await native.close();
  }
});

it("persists a generated title when the user explicitly saves it", async () => {
  const { path } = await fixture();
  await renameMeeting(selected, selected.title, signal);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ title: selected.title, title_source: "user" });
});

it("leaves the manifest intact after cancellation", async () => {
  const { path, original } = await fixture();
  await expect(renameMeeting(selected, "New title", AbortSignal.abort())).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(original);
});
