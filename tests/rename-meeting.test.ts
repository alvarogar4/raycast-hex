import { afterEach, expect, it, vi } from "vitest";
import Meetings from "../src/meetings";
import { RenameMeetingForm } from "../src/rename-meeting";
import { renameMeeting } from "../src/meeting-title";
import type { Meeting } from "../src/hex";

const ui = vi.hoisted(() => ({
  pop: vi.fn(),
  setError: vi.fn(),
  setDraft: vi.fn(),
  usePromise: vi.fn(),
  effect: vi.fn(),
}));
vi.mock("../src/meeting-title", async (original) => ({
  ...(await original<typeof import("../src/meeting-title")>()),
  renameMeeting: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [
    initial,
    typeof initial === "string" ? ui.setDraft : typeof initial === "boolean" ? vi.fn() : ui.setError,
  ],
  useRef: () => ({ current: null }),
  useEffect: ui.effect,
}));
vi.mock("@raycast/api", () => ({
  Action: Object.assign(() => null, { Push: "push", SubmitForm: "submit", Style: { Destructive: "destructive" } }),
  ActionPanel: Object.assign(() => null, { Section: "section" }),
  Icon: { Pencil: "pencil" },
  Keyboard: { Shortcut: { Common: { Edit: { modifiers: ["cmd"], key: "e" } } } },
  List: Object.assign(() => null, { Item: "item", EmptyView: "empty", Section: "section" }),
  Form: Object.assign(() => null, { TextField: "textfield", Description: "description" }),
  useNavigation: () => ({ pop: ui.pop }),
}));
vi.mock("@raycast/utils", () => ({ usePromise: ui.usePromise }));
afterEach(() => vi.clearAllMocks());

const library = { root: "/test/library", executable: "/test/hex" };
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
      library,
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
  expect(form.props.children[0].props.value).toBe(second.title);
  expect(form.props.children[1].props.text).toContain("meetings rename");
  await form.props.actions.props.children.props.onSubmit({ title: "  New title  " });
  expect(renameMeeting).toHaveBeenCalledExactlyOnceWith(second, "New title", expect.any(AbortSignal), library);
  expect(refresh).toHaveBeenCalledOnce();
  expect(ui.pop).toHaveBeenCalledOnce();
  for (const item of [active, transcribing]) {
    const draft = RenameMeetingForm(rename(item).props.target.props);
    expect(draft.props.children[0].props.value).toBe(item.props.title);
    expect(draft.props.children[1].props.text).toContain("transcription");
  }
  expect(rename(empty)).toBeUndefined();
});

it("keeps a blank or rejected edit in the form", async () => {
  const refresh = vi.fn();
  const submit = RenameMeetingForm({ meeting, library, refresh }).props.actions.props.children.props.onSubmit;
  await submit({ title: "   " });
  expect(renameMeeting).not.toHaveBeenCalled();
  expect(ui.setError).toHaveBeenCalledWith("Enter a meeting title.");
  vi.mocked(renameMeeting).mockRejectedValueOnce(new Error("Recording changed"));
  await submit({ title: "New title" });
  expect(ui.setError).toHaveBeenCalledWith("Recording changed");
  expect(refresh).toHaveBeenCalledOnce();
  expect(ui.pop).not.toHaveBeenCalled();
});

it("keeps an old save from dismissing another form and ignores repeat submissions", async () => {
  let complete: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  vi.mocked(renameMeeting).mockReturnValueOnce(promise);
  const refresh = vi.fn();
  const form = RenameMeetingForm({ meeting, library, refresh });
  const submit = form.props.actions.props.children.props.onSubmit;
  const save = submit({ title: "First change" });
  form.props.children[0].props.onChange("Unsubmitted correction");
  expect(ui.setDraft).not.toHaveBeenCalled();
  await submit({ title: "Second change" });
  expect(renameMeeting).toHaveBeenCalledTimes(1);
  const unmount = ui.effect.mock.lastCall![0]();
  unmount();
  complete();
  await save;
  expect(refresh).toHaveBeenCalledOnce();
  expect(ui.pop).not.toHaveBeenCalled();
});
