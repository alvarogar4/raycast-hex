import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameMeeting } from "../src/meeting-title";
import { readMeetings, type Meeting } from "../src/hex";

vi.mock("@raycast/api", () => ({ getPreferenceValues: () => ({}) }));
vi.mock("../src/hex", () => ({ readMeetings: vi.fn() }));
const temp = await mkdtemp(join(tmpdir(), "raycast-title-"));
afterAll(() => rm(temp, { recursive: true, force: true }));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
const signal = new AbortController().signal;
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
    await expect(renameMeeting(selected, "New title", signal)).rejects.toThrow("Hex is running");
    await writeFile(path, original.replace('"Generated title"', '"New notes"'));
  } finally {
    await native.close();
  }
  await renameMeeting(selected, "New title", signal);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ title: "New title", notes: { title: "New notes" } });
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
