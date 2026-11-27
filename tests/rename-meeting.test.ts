import { afterEach, expect, it, vi } from "vitest";
import Meetings from "../src/meetings";
import { RenameMeetingForm } from "../src/rename-meeting";
import { renameMeeting } from "../src/meeting-title";
import type { Meeting } from "../src/hex";

const ui = vi.hoisted(() => ({ pop: vi.fn(), setError: vi.fn(), usePromise: vi.fn(), effect: vi.fn() }));
vi.mock("../src/meeting-title", () => ({ renameMeeting: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [initial, typeof initial === "boolean" ? vi.fn() : ui.setError],
  useRef: () => ({ current: null }),
  useEffect: ui.effect,
}));
vi.mock("@raycast/api", () => ({
  Action: Object.assign(() => null, { Push: "push", SubmitForm: "submit", Style: { Destructive: "destructive" } }),
  ActionPanel: Object.assign(() => null, { Section: "section" }),
  Icon: { Pencil: "pencil" },
  Keyboard: { Shortcut: { Common: { Edit: { modifiers: ["cmd"], key: "e" } } } },
  List: Object.assign(() => null, { Item: "item", EmptyView: "empty", Section: "section" }),
  Form: Object.assign(() => null, { TextField: "textfield" }),
  useNavigation: () => ({ pop: ui.pop }),
}));
vi.mock("@raycast/utils", () => ({ usePromise: ui.usePromise }));
afterEach(() => vi.clearAllMocks());

const meeting: Meeting = {
  id: "first",
  title: "Weekly sync",
  status: "complete",
  timestamp_ms: 1,
  application: null,
  in_progress: false,
};

it("opens a prefilled Raycast form for exactly the selected row and returns to the list after saving", async () => {
  const second = { ...meeting, id: "second" };
  const refresh = vi.fn();
  ui.usePromise.mockReturnValue({
    data: {
      meetings: [
        meeting,
        second,
        { ...meeting, id: "active", in_progress: true },
        { ...meeting, id: "busy", status: "transcribing" },
      ],
    },
    revalidate: refresh,
  });
  const [empty, section] = Meetings().props.children;
  const [, selected, active, transcribing] = section.props.children;
  function rename(item: typeof empty) {
    return item.props.actions.props.children.find(
      (action: { props: { title?: string } } | null) => action?.props?.title === "Rename Meeting",
    );
  }
  const action = rename(selected);
  expect(action.type).toBe("push");
  expect(action.props.shortcut).toEqual({ modifiers: ["cmd"], key: "e" });
  expect(action.props.target.type).toBe(RenameMeetingForm);
  const form = RenameMeetingForm(action.props.target.props);
  expect(form.props.children.props.defaultValue).toBe(second.title);
  vi.mocked(renameMeeting).mockResolvedValueOnce(true);
  await form.props.actions.props.children.props.onSubmit({ title: "  New title  " });
  expect(renameMeeting).toHaveBeenCalledExactlyOnceWith(second, "New title", expect.any(AbortSignal));
  expect(refresh).toHaveBeenCalledOnce();
  expect(ui.pop).toHaveBeenCalledOnce();
  expect(rename(active)).toBeUndefined();
  expect(rename(transcribing)).toBeUndefined();
  expect(rename(empty)).toBeUndefined();
});

it("keeps a blank or rejected edit in the form", async () => {
  const refresh = vi.fn();
  const submit = RenameMeetingForm({ meeting, refresh }).props.actions.props.children.props.onSubmit;
  await submit({ title: "   " });
  expect(renameMeeting).not.toHaveBeenCalled();
  expect(ui.setError).toHaveBeenCalledWith("Enter a meeting title.");
  vi.mocked(renameMeeting).mockRejectedValueOnce(new Error("Recording changed"));
  await submit({ title: "New title" });
  expect(ui.setError).toHaveBeenCalledWith("Recording changed");
  expect(refresh).toHaveBeenCalledOnce();
  expect(ui.pop).not.toHaveBeenCalled();
});

it("keeps the draft open when the user cancels the quit confirmation", async () => {
  const refresh = vi.fn();
  vi.mocked(renameMeeting).mockResolvedValueOnce(false);
  await RenameMeetingForm({ meeting, refresh }).props.actions.props.children.props.onSubmit({ title: "New title" });
  expect(ui.pop).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it("keeps an old save from dismissing another form and ignores repeat submissions", async () => {
  let complete: (saved: boolean) => void = () => {};
  const promise = new Promise<boolean>((resolve) => {
    complete = resolve;
  });
  vi.mocked(renameMeeting).mockReturnValueOnce(promise);
  const submit = RenameMeetingForm({ meeting, refresh: vi.fn() }).props.actions.props.children.props.onSubmit;
  const save = submit({ title: "First change" });
  await submit({ title: "Second change" });
  expect(renameMeeting).toHaveBeenCalledTimes(1);
  const unmount = ui.effect.mock.lastCall![0]();
  unmount();
  complete(true);
  await save;
  expect(ui.pop).not.toHaveBeenCalled();
});
