import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { LaunchType } from "@raycast/api";
import { z } from "zod";
import { executeHex, HexStopped } from "../src/cli";
import { control, readHistory, readStatus, readMeetings, supportsMeetingRename, renameWithHex } from "../src/hex";
import { cancelPreparation, chooseModel } from "../src/switch-model";
import { runShortcut } from "../src/no-view";
import StartMeeting from "../src/start-meeting";
import StopMeeting from "../src/stop-meeting";
import Meetings from "../src/meetings";

const ui = vi.hoisted(() => ({
  environment: { commandMode: "no-view" },
  LaunchType: { UserInitiated: "userInitiated" },
  Icon: { Stop: "stop", Window: "window", Microphone: "mic" },
  List: Object.assign(() => null, { EmptyView: "empty", Section: "section" }),
  ActionPanel: "actions",
  Action: "action",
  getPreferenceValues: vi.fn(),
  confirmAlert: vi.fn(),
  closeMainWindow: vi.fn(),
  showHUD: vi.fn(),
  showToast: vi.fn(),
  Alert: { ActionStyle: { Destructive: "destructive" } },
  Toast: { Style: { Failure: "failure", Success: "success" } },
}));
vi.mock("@raycast/api", () => ui);
const usePromise = vi.hoisted(() => vi.fn());
vi.mock("@raycast/utils", () => ({ usePromise }));

const dir = mkdtempSync(join(tmpdir(), "raycast hex test "));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  ui.environment.commandMode = "no-view";
  vi.clearAllMocks();
});
function fixture(script: string) {
  const path = join(dir, "fixture cli");
  writeFileSync(path, "#!/usr/bin/env node\n" + script, { mode: 0o700 });
  ui.getPreferenceValues.mockReturnValue({ hexPath: path });
  return path;
}
const echoDone =
  'process.stdout.write(JSON.stringify({version:4,status:"done",changed:true,message:JSON.stringify(process.argv.slice(2))}))';

it("detects native rename support and sends the selected ID and title as literal arguments to the selected library", async () => {
  const signal = new AbortController().signal;
  const title = '--new "title" ☕';
  fixture(`
    const args = process.argv.slice(2);
    const assert = require("node:assert/strict");
    if (args.includes("--help")) {
      assert.deepEqual(args, ["meetings", "rename", "--help"]);
      process.exit(0);
    }
    assert.equal(process.env.HEX_APPLICATION_SUPPORT_DIR, "/selected/library");
    ${echoDone}
  `);
  expect(await supportsMeetingRename(signal)).toBe(true);
  const reply = await renameWithHex("123-1", title, "/selected/library", signal);
  expect(JSON.parse(reply.message)).toEqual(["meetings", "rename", "--json", "--", "123-1", title]);
});

it("recognizes the legacy CLI and propagates unexpected probe failures", async () => {
  const signal = new AbortController().signal;
  fixture(`process.stderr.write("error: unrecognized subcommand 'rename'"); process.exit(2);`);
  expect(await supportsMeetingRename(signal)).toBe(false);
  fixture(`process.stderr.write("private diagnostic"); process.exit(2);`);
  await expect(supportsMeetingRename(signal)).rejects.toThrow("Could not check");
});

it("passes private search and filter values as literal arguments and preserves entry text", async () => {
  const query = '--raw "two words"; $5';
  const args = ["history", "--json", "--raw", "--limit", "50", `--search=${query}`, "--app=My App", "--since", "3d"];
  const entry = { id: 1, timestamp_ms: 1234, application: null, final_text: "\n final\n", raw_text: " raw " };
  fixture(
    `require("node:assert/strict").deepEqual(process.argv.slice(2),${JSON.stringify(args)}); process.stdout.write(${JSON.stringify(JSON.stringify({ version: 1, entries: [entry], truncated: false }))})`,
  );
  expect((await readHistory(query, "My App", "3d", 50)).entries).toEqual([entry]);
});

it.each([
  [
    ["model", "use"],
    ["--", "installed-id"],
  ],
  [
    ["model", "use"],
    ["--language=fr", "--", "installed-id"],
  ],
  [
    ["model", "install"],
    ["--", "download-id"],
  ],
  [["model", "cancel"], []],
  [
    ["vocabulary", "add"],
    ["--sounds-like=a,b", "--", "--my term"],
  ],
  [
    ["vocabulary", "remove"],
    ["--", "--my term"],
  ],
  [
    ["settings", "set"],
    ["--", "microphone", "name with spaces"],
  ],
  [
    ["settings", "set"],
    ["--", "mappings", '{"x":"y"}'],
  ],
  [["meetings", "record"], []],
  [["meetings", "stop"], []],
  ...["history", "meetings"].map((pane) => [
    ["window", "show"],
    ["--", pane],
  ]),
])("sends a single JSON control invocation for %j %j", async (command, args) => {
  fixture(echoDone);
  expect(JSON.parse((await control(command, args)).message)).toEqual([...command, "--json", ...args]);
});

it.each([
  ["dictation", "start"],
  ["dictation", "stop"],
  ["dictation", "toggle"],
  ["dictation", "cancel"],
  ["paste-last"],
])("runs the no-view shortcut %s %s through the configured CLI", async (...command) => {
  fixture(echoDone);
  ui.confirmAlert.mockResolvedValue(true);
  await runShortcut(command);
  expect(ui.showHUD).toHaveBeenLastCalledWith(JSON.stringify([...command, "--json"]));
});

it("dismisses discard before opening the CLI", async () => {
  ui.confirmAlert.mockResolvedValue(false);
  ui.getPreferenceValues.mockClear();
  await runShortcut(["dictation", "cancel"]);
  expect(ui.getPreferenceValues).not.toHaveBeenCalled();
});

it("offers Start Hex after exit 3 and never replays the failed shortcut", async () => {
  fixture(`if(process.argv[2]!=="start") process.exit(3); ${echoDone}`);
  ui.confirmAlert.mockResolvedValue(true);
  ui.getPreferenceValues.mockClear();
  await runShortcut(["dictation", "toggle"]);
  expect(ui.confirmAlert).toHaveBeenLastCalledWith({
    title: "Hex isn't running",
    primaryAction: { title: "Start Hex" },
  });
  expect(ui.showToast).toHaveBeenLastCalledWith({ title: JSON.stringify(["start", "--json"]) });
  expect(ui.getPreferenceValues).toHaveBeenCalledTimes(2);
});

it.each([
  [0, "not-json", "Unexpected Hex JSON reply"],
  [0, '{"version":99}', "Unexpected Hex JSON reply"],
  [1, "", "Hex could not complete"],
  [2, "", "Hex rejected the command arguments"],
  [1, '{"version":4,"status":"error","message":"Meetings are off"}', "Meetings are off"],
])("sanitizes failure output for exit %i", async (code, output, message) => {
  const path = fixture(
    `process.stdout.write(${JSON.stringify(output)});process.stderr.write("private sample");process.exitCode=${code}`,
  );
  const task = executeHex(path, ["private sample"], z.object({ version: z.literal(4) }));
  await expect(task).rejects.toThrow(message);
  await expect(task).rejects.not.toThrow("private sample");
});
it("maps exit 3 even without a JSON body", async () => {
  await expect(executeHex(fixture("process.exit(3)"), [], z.never())).rejects.toBeInstanceOf(HexStopped);
});

const availableModel = { id: "m", name: "Sample Model", size: "500 MB", installed: false, languages: ["en"] };
it("shows download size and leaves the CLI untouched when installation is dismissed", async () => {
  ui.getPreferenceValues.mockClear();
  ui.confirmAlert.mockResolvedValue(false);
  await chooseModel(availableModel);
  expect(ui.confirmAlert).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: expect.stringContaining("500 MB") }),
  );
  expect(ui.getPreferenceValues).not.toHaveBeenCalled();
});

it("sends a confirmed install and uses an installed model directly", async () => {
  fixture(echoDone);
  ui.confirmAlert.mockResolvedValue(true);
  await chooseModel(availableModel);
  expect(ui.showToast).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: JSON.stringify(["model", "install", "--json", "--", "m"]) }),
  );
  ui.confirmAlert.mockClear();
  await chooseModel({ ...availableModel, installed: true });
  expect(ui.confirmAlert).not.toHaveBeenCalled();
  expect(ui.showToast).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: JSON.stringify(["model", "use", "--json", "--", "m"]) }),
  );
});

function statusReply(preparing: string | null, error: string | null) {
  return {
    version: 4,
    status: "status",
    capture: { state: "idle", recording: null, pending_jobs: 0 },
    meeting: { state: "idle", title: null, elapsed_seconds: null },
    model: { id: "selected", name: "Selected", language: "en", preparing, error },
  };
}
function emit(value: unknown) {
  return `process.stdout.write(${JSON.stringify(JSON.stringify(value))})`;
}

it("stops before cancellation if another model starts preparing during confirmation", async () => {
  fixture(emit(statusReply("original", null)));
  ui.getPreferenceValues.mockClear();
  ui.confirmAlert.mockImplementationOnce(async () => {
    fixture(emit(statusReply("replacement", null)));
    return true;
  });
  await cancelPreparation();
  expect(ui.getPreferenceValues).toHaveBeenCalledTimes(2);
  expect(ui.showToast).toHaveBeenLastCalledWith({ title: expect.stringContaining("changed") });
});
it("preserves an asynchronous download failure in status", async () => {
  fixture(emit(statusReply(null, "Download interrupted")));
  expect((await readStatus()).model.error).toBe("Download interrupted");
});
it("parses populated meeting metadata without accessing a transcript", async () => {
  const meeting = {
    id: "sample",
    title: "Example",
    application: null,
    status: "complete",
    timestamp_ms: 123,
    in_progress: false,
  };
  fixture(emit({ version: 1, meetings: [meeting], truncated: false }));
  expect((await readMeetings()).meetings).toEqual([meeting]);
});

it.each([
  [undefined, []],
  ["   ", []],
  ['  --stop "two words"; $5  ', ['--title=--stop "two words"; $5']],
] as const)("starts a meeting with the optional title %j", async (title, titleArgs) => {
  fixture(echoDone);
  await StartMeeting({ arguments: { title }, launchType: LaunchType.UserInitiated });
  expect(ui.closeMainWindow).toHaveBeenCalledBefore(ui.getPreferenceValues);
  expect(ui.showHUD).toHaveBeenCalledExactlyOnceWith(JSON.stringify(["meetings", "record", "--json", ...titleArgs]));
  expect(ui.showToast).not.toHaveBeenCalled();
});

it.each([
  [true, "Transcribing"],
  [false, "No meeting is recording"],
] as const)("shows a HUD for a stop with changed=%s", async (changed, expected) => {
  fixture(emit({ version: 4, status: "done", changed, message: changed ? "Transcribing" : "Nothing to change" }));
  await StopMeeting();
  expect(ui.closeMainWindow).toHaveBeenCalledBefore(ui.getPreferenceValues);
  expect(ui.showHUD).toHaveBeenCalledExactlyOnceWith(expected);
  expect(ui.showToast).not.toHaveBeenCalled();
});

it("offers Start Hex after a meeting shortcut gets exit 3", async () => {
  fixture("process.exit(3)");
  ui.confirmAlert.mockResolvedValueOnce(false);
  await StopMeeting();
  expect(ui.confirmAlert).toHaveBeenLastCalledWith({
    title: "Hex isn't running",
    primaryAction: { title: "Start Hex" },
  });
});

it("refreshes the Meetings list after starting and stopping a recording", async () => {
  ui.environment.commandMode = "view";
  const revalidate = vi.fn();
  usePromise.mockReturnValue({ data: { meetings: [] }, revalidate });
  const actions = Meetings().props.children[0].props.actions.props.children;
  fixture(echoDone);
  await actions[1].props.onAction();
  await actions[2].props.onAction();
  expect(ui.showToast).toHaveBeenLastCalledWith({
    style: "success",
    title: JSON.stringify(["meetings", "stop", "--json"]),
  });
  expect(revalidate).toHaveBeenCalledTimes(2);
});
