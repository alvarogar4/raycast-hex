import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Meetings from "../src/meetings";
import { trashMeeting } from "../src/trash-meeting";
import type { Meeting } from "../src/hex";

const ui = vi.hoisted(() => ({
  Action: Object.assign(() => null, { Style: { Destructive: "destructive" } }),
  ActionPanel: Object.assign(() => null, { Section: "actionSection" }),
  Alert: { ActionStyle: { Destructive: "destructive" } },
  Icon: { Trash: "trash", Microphone: "mic", Stop: "stop" },
  List: Object.assign(() => null, { Item: "item", EmptyView: "empty", Section: "section" }),
  Toast: { Style: { Success: "success", Failure: "failure" } },
  confirmAlert: vi.fn(),
  getPreferenceValues: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock("@raycast/api", () => ui);
const usePromise = vi.hoisted(() => vi.fn());
vi.mock("@raycast/utils", () => ({ usePromise }));
const temp = mkdtempSync(join(tmpdir(), "hex-meeting-command-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
const row: Meeting = {
  id: "123-456",
  title: "Planning",
  timestamp_ms: 12345,
  status: "complete",
  in_progress: false,
  application: null,
};

function fixture(rows: Meeting[], refused = false) {
  const dir = mkdtempSync(join(temp, "case-"));
  vi.stubEnv("HEX_APPLICATION_SUPPORT_DIR", dir);
  const folder = join(dir, "meetings", row.id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({ id: row.id, export_path: "/Documents/Planning.md" }));
  const cli = join(dir, "hex");
  const log = join(dir, "calls");
  writeFileSync(log, "");
  const done = refused
    ? { version: 4, status: "error", code: "meeting-notes", message: "Wait for the notes to finish before deleting" }
    : { version: 4, status: "done", changed: true, message: "Moved to Trash" };
  writeFileSync(
    cli,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+"\\n");
const list = args[1] === "list";
process.stdout.write(JSON.stringify(list ? ${JSON.stringify({ version: 1, meetings: rows, truncated: false })} : ${JSON.stringify(done)}));
process.exitCode = !list && ${refused} ? 1 : 0;
`,
    { mode: 0o700 },
  );
  ui.getPreferenceValues.mockReturnValue({ hexPath: cli });
  ui.confirmAlert.mockResolvedValue(true);
  return () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s));
}

it("keeps Trash in its own action section and confirms the selected meeting", async () => {
  const calls = fixture([row]);
  const revalidate = vi.fn();
  usePromise.mockReturnValue({ data: { meetings: [row] }, revalidate });
  const [empty, section] = Meetings().props.children;
  const actions = section.props.children[0].props.actions.props.children;
  expect(actions[0].props.title).toBe("Open Meetings in Hex");
  expect(
    empty.props.actions.props.children.some(
      (action: { type?: unknown } | null) => action?.type === ui.ActionPanel.Section,
    ),
  ).toBe(false);
  const sectionForTrash = actions.at(-1);
  expect(sectionForTrash.type).toBe(ui.ActionPanel.Section);
  const trash = sectionForTrash.props.children;
  expect(trash.props.title).toBe("Move Meeting to Trash");
  expect(trash.props.shortcut).toEqual({ modifiers: ["ctrl"], key: "k" });
  await trash.props.onAction();
  expect(ui.confirmAlert.mock.calls[0][0].message).toContain("/Documents/Planning.md");
  expect(calls()).toEqual([
    ["meetings", "list", "--json", "--limit", "200"],
    ["meetings", "list", "--json", "--limit", "200"],
    ["meetings", "delete", "--json", "--", row.id],
  ]);
  expect(revalidate).toHaveBeenCalledOnce();
});

it("leaves the meeting in place when the native notes worker refuses deletion", async () => {
  const calls = fixture([row], true);
  expect(await trashMeeting(row)).toBe(false);
  expect(calls()).toHaveLength(3);
  expect(ui.showToast).toHaveBeenCalledWith(
    expect.objectContaining({ style: "failure", title: expect.stringContaining("notes") }),
  );
});

it("cancels without issuing a delete", async () => {
  const calls = fixture([row]);
  ui.confirmAlert.mockResolvedValueOnce(false);
  expect(await trashMeeting(row)).toBe(false);
  expect(calls()).toHaveLength(1);
});

it.each([{ rows: [] }, { rows: [{ ...row, in_progress: true }] }, { rows: [{ ...row, timestamp_ms: 7777 }] }])(
  "refuses a stale selection (%#)",
  async ({ rows }) => {
    const calls = fixture(rows);
    expect(await trashMeeting(row)).toBe(false);
    expect(calls()).toHaveLength(1);
  },
);

it("refuses an active recording before asking to move it", async () => {
  const calls = fixture([{ ...row, in_progress: true }]);
  expect(await trashMeeting(row)).toBe(false);
  expect(ui.confirmAlert).not.toHaveBeenCalled();
  expect(calls()).toHaveLength(1);
});

it("takes a recording that has finished since the list was opened to the confirmation", async () => {
  const calls = fixture([row]);
  expect(await trashMeeting({ ...row, status: "recording", in_progress: true })).toBe(true);
  expect(calls().at(-1)).toEqual(["meetings", "delete", "--json", "--", row.id]);
});

it("refuses an export path that changes after confirmation", async () => {
  const calls = fixture([row]);
  ui.confirmAlert.mockImplementationOnce(async () => {
    writeFileSync(
      join(process.env.HEX_APPLICATION_SUPPORT_DIR!, "meetings", row.id, "manifest.json"),
      JSON.stringify({ id: row.id, export_path: "/Documents/Elsewhere.md" }),
    );
    return true;
  });
  expect(await trashMeeting(row)).toBe(false);
  expect(calls()).toHaveLength(2);
});

it("refuses a manifest that does not belong to the selected meeting", async () => {
  const calls = fixture([row]);
  writeFileSync(
    join(process.env.HEX_APPLICATION_SUPPORT_DIR!, "meetings", row.id, "manifest.json"),
    JSON.stringify({ id: "other" }),
  );
  expect(await trashMeeting(row)).toBe(false);
  expect(ui.confirmAlert).not.toHaveBeenCalled();
  expect(calls()).toHaveLength(1);
});
