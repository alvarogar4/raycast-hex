import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, assert, expect, it, vi } from "vitest";
import { LaunchType } from "@raycast/api";
import { z } from "zod";
import { executeHex, HexStopped } from "../src/cli";
import { control, readHistory, readStatus, readMeetings } from "../src/hex";
import { cancelPreparation, chooseModel } from "../src/switch-model";
import { runShortcut } from "../src/no-view";
import StartMeeting from "../src/start-meeting";
import StopMeeting from "../src/stop-meeting";
import MeetingMenuBar from "../src/meeting-menu-bar";
import Meetings from "../src/meetings";

const ui = vi.hoisted(() => ({
  environment: { commandMode: "no-view", commandName: "" },
  LaunchType: { Background: "background", UserInitiated: "userInitiated" },
  launchCommand: vi.fn().mockResolvedValue(undefined),
  Color: { Red: "red" },
  Icon: { CircleFilled: "circle", Stop: "stop", Window: "window", Microphone: "mic" },
  MenuBarExtra: Object.assign(() => null, { Section: "section", Item: "item" }),
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
  ui.environment.commandName = "";
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
  const meeting = { id: "sample", title: "Example", application: null, status: "complete", timestamp_ms: 123 };
  fixture(emit({ version: 1, meetings: [meeting], truncated: false }));
  expect((await readMeetings()).meetings).toEqual([meeting]);
});

const menuRefresh = { name: "meeting-menu-bar", type: LaunchType.Background };

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
  expect(ui.launchCommand).toHaveBeenCalledExactlyOnceWith(menuRefresh);
});

it.each([
  [true, "Transcribing"],
  [false, "No meeting is recording"],
] as const)("shows a HUD for a stop with changed=%s, even when the menu bar is disabled", async (changed, expected) => {
  fixture(emit({ version: 4, status: "done", changed, message: changed ? "Transcribing" : "Nothing to change" }));
  ui.launchCommand.mockRejectedValueOnce(new Error("Command disabled"));
  await StopMeeting();
  expect(ui.closeMainWindow).toHaveBeenCalledBefore(ui.getPreferenceValues);
  expect(ui.showHUD).toHaveBeenCalledExactlyOnceWith(expected);
  expect(ui.showToast).not.toHaveBeenCalled();
  expect(ui.launchCommand).toHaveBeenCalledExactlyOnceWith(menuRefresh);
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

it("waits for status, then hides a stale recording after an exit 3", async () => {
  usePromise.mockReturnValue({ isLoading: true });
  expect(MeetingMenuBar()?.props.isLoading).toBe(true);
  expect(usePromise).toHaveBeenLastCalledWith(readStatus, [], expect.anything());
  fixture("process.exit(3)");
  const error = await readStatus().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(HexStopped);
  usePromise.mockReturnValue({ error, data: { meeting: { state: "recording" } }, isLoading: false });
  expect(MeetingMenuBar()).toBeNull();
});

it.each(["idle", "starting", "transcribing"])("hides the menu bar while the meeting is %s", async (state) => {
  const status = statusReply(null, null);
  status.meeting.state = state;
  fixture(emit(status));
  usePromise.mockReturnValue({ data: await readStatus(), isLoading: false });
  expect(MeetingMenuBar()).toBeNull();
});

it.each([
  [0, "0m"],
  [65, "1m"],
  [3599, "59m"],
  [3600, "1h 00m"],
  [3725, "1h 02m"],
  [null, undefined],
])("renders the recording title, red icon and elapsed time for %s seconds", async (seconds, expected) => {
  fixture(
    emit({
      ...statusReply(null, null),
      meeting: { state: "recording", title: "Design sync", elapsed_seconds: seconds },
    }),
  );
  usePromise.mockReturnValue({ data: await readStatus(), isLoading: false });
  const bar = MeetingMenuBar();
  assert(bar);
  expect(bar.props.icon).toEqual({ source: "circle", tintColor: "red" });
  expect(bar.props.title).toBe(expected);
  expect(bar.props.children.props.title).toBe("Design sync");
});

function recordingMenu() {
  ui.environment.commandMode = "menu-bar";
  ui.environment.commandName = "meeting-menu-bar";
  const revalidate = vi.fn();
  usePromise.mockReturnValue({
    data: { meeting: { state: "recording", title: null, elapsed_seconds: 1 } },
    revalidate,
  });
  const bar = MeetingMenuBar();
  assert(bar);
  expect(bar.props.children.props.title).toBe("Untitled Meeting");
  const items = bar.props.children.props.children;
  expect(items).toHaveLength(2);
  return { stop: items[0].props, open: items[1].props, revalidate };
}

it("stops and opens the Meetings pane from the recording menu", async () => {
  const { stop, open, revalidate } = recordingMenu();
  fixture(echoDone);
  expect(stop.title).toBe("Stop & Transcribe");
  await stop.onAction();
  expect(ui.showHUD).toHaveBeenLastCalledWith(JSON.stringify(["meetings", "stop", "--json"]));
  expect(revalidate).toHaveBeenCalledOnce();
  expect(open.title).toBe("Open Meetings in Hex");
  await open.onAction();
  expect(ui.showHUD).toHaveBeenLastCalledWith(JSON.stringify(["window", "show", "--json", "--", "meetings"]));
  expect(ui.showToast).not.toHaveBeenCalled();
  expect(ui.launchCommand).not.toHaveBeenCalled();
});

it.each(["stop", "open"] as const)("reports exit 3 from the menu bar %s action in a HUD", async (action) => {
  const menu = recordingMenu();
  fixture("process.exit(3)");
  await menu[action].onAction();
  expect(ui.showHUD).toHaveBeenCalledExactlyOnceWith("Hex isn't running");
  expect(ui.confirmAlert).not.toHaveBeenCalled();
  expect(ui.showToast).not.toHaveBeenCalled();
  expect(ui.launchCommand).not.toHaveBeenCalled();
});

it("revalidates after a successful menu stop even if the HUD fails", async () => {
  const { stop, revalidate } = recordingMenu();
  fixture(echoDone);
  const failure = new Error("HUD unavailable");
  ui.showHUD.mockRejectedValueOnce(failure);
  await expect(stop.onAction()).rejects.toBe(failure);
  expect(revalidate).toHaveBeenCalledOnce();
  expect(ui.showHUD).toHaveBeenCalledOnce();
  expect(ui.showToast).not.toHaveBeenCalled();
});

it("refreshes both the list and the menu bar from existing meeting actions", async () => {
  ui.environment.commandMode = "view";
  ui.environment.commandName = "meetings";
  const revalidate = vi.fn();
  usePromise.mockReturnValue({ data: { meetings: [] }, revalidate });
  const actions = Meetings().props.children[0].props.actions.props.children;
  fixture(echoDone);
  ui.launchCommand.mockClear();
  await actions[1].props.onAction();
  await actions[2].props.onAction();
  expect(ui.showToast).toHaveBeenLastCalledWith({
    style: "success",
    title: JSON.stringify(["meetings", "stop", "--json"]),
  });
  expect(revalidate).toHaveBeenCalledTimes(2);
  expect(ui.launchCommand.mock.calls).toEqual([[menuRefresh], [menuRefresh]]);
});
