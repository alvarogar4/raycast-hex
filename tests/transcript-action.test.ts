import { afterEach, expect, it, vi } from "vitest";
import { trashTranscript } from "../src/trash-transcript";

const mocks = vi.hoisted(() => ({
  confirmDiscard: vi.fn(),
  showHexError: vi.fn(),
  showToast: vi.fn(),
  lockHistory: vi.fn(),
  close: vi.fn(),
  version: vi.fn(),
  moveLockedTranscript: vi.fn(),
  getPreferenceValues: vi.fn(),
}));
vi.mock("../src/feedback", () => mocks);
vi.mock("../src/transcript-store", () => mocks);
vi.mock("@raycast/api", () => ({ ...mocks, Toast: { Style: { Failure: "failure", Success: "success" } } }));
vi.mock("node:fs/promises", () => ({ realpath: (path: string) => Promise.resolve(path) }));
vi.mock("node:child_process", () => ({
  execFile: (_path: string, _args: string[], done: (error: null, result: { stdout: string }) => void) =>
    done(null, { stdout: mocks.version() }),
}));
const entry = { id: 2, timestamp_ms: 123, application: null, final_text: "synthetic", raw_text: "raw" };

function setup() {
  mocks.version.mockReturnValue("hex 3.5.0");
  mocks.getPreferenceValues.mockReturnValue({});
  mocks.confirmDiscard.mockResolvedValue(true);
  mocks.lockHistory.mockResolvedValue({ close: mocks.close });
}
afterEach(() => vi.resetAllMocks());

it("identifies the selected entry and cancels before acquiring the lock", async () => {
  setup();
  mocks.confirmDiscard.mockResolvedValue(false);
  expect(await trashTranscript(entry)).toBe(false);
  expect(mocks.confirmDiscard).toHaveBeenCalledWith(
    "Move Transcript to Trash?",
    expect.stringContaining("#2 ·"),
    "Move to Trash",
  );
  expect(mocks.lockHistory).not.toHaveBeenCalled();
  expect(mocks.getPreferenceValues).not.toHaveBeenCalled();
});

it("refuses a busy history without writing", async () => {
  setup();
  mocks.lockHistory.mockResolvedValue(undefined);
  expect(await trashTranscript(entry)).toBe(false);
  expect(mocks.showHexError).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("Quit Hex") }),
  );
  expect(mocks.moveLockedTranscript).not.toHaveBeenCalled();
});

it.each([true, false])("releases the lock when move success is %s", async (success) => {
  setup();
  if (!success) mocks.moveLockedTranscript.mockRejectedValueOnce(new Error("Trash is unavailable"));
  expect(await trashTranscript(entry)).toBe(success);
  expect(mocks.moveLockedTranscript).toHaveBeenCalledWith(expect.any(String), entry);
  expect(mocks.close).toHaveBeenCalledOnce();
});

it.each([
  ["hex 3.4.0", true],
  ["hex 3.5.0", true],
  ["hex 3.6.0", false],
] as const)("checks the storage format for %s", async (version, supported) => {
  setup();
  mocks.version.mockReturnValue(version);
  expect(await trashTranscript(entry)).toBe(supported);
  expect(mocks.lockHistory).toHaveBeenCalledTimes(supported ? 1 : 0);
});
