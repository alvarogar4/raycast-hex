import { expect, it, vi } from "vitest";
import SearchHistory from "../src/search-history";

// Hold the CLI reply at the previous query while Raycast delivers a keystroke.
const input = vi.hoisted(() => ({ query: "" }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) =>
    typeof initial === "string"
      ? [
          input.query,
          (text: string) => {
            input.query = text;
          },
        ]
      : [initial, vi.fn()],
  useRef: () => ({ current: null }),
}));
const result = vi.hoisted(() => ({
  data: {
    query: "",
    app: "",
    since: "",
    truncated: false,
    entries: [{ id: 1, timestamp_ms: 123, application: "Example", final_text: " exact final\n", raw_text: " raw\n" }],
  },
  isLoading: false,
  revalidate: vi.fn(),
}));
const action = vi.hoisted(() => ({ trashTranscript: vi.fn(), enabled: true }));
vi.mock("../src/trash-transcript", () => action);
vi.mock("@raycast/utils", () => ({ usePromise: () => result }));
vi.mock("@raycast/api", () => {
  const component = () => null;
  return {
    Action: Object.assign(component, {
      Push: "push",
      Paste: "paste",
      CopyToClipboard: "copy",
      Style: { Destructive: "destructive" },
    }),
    getPreferenceValues: () => ({ allowTranscriptTrash: action.enabled }),
    ActionPanel: Object.assign(component, { Section: "actionSection" }),
    List: Object.assign(component, {
      EmptyView: "empty",
      Dropdown: Object.assign(component, { Item: "option" }),
      Item: Object.assign(component, {
        Detail: Object.assign(component, { Metadata: Object.assign(component, { Label: "label" }) }),
      }),
    }),
    Icon: { Filter: "filter" },
    Keyboard: { Shortcut: { Common: { Copy: { modifiers: ["cmd", "shift"], key: "c" } } } },
  };
});
it("binds Control-K to the selected transcript and refreshes only after a move", async () => {
  const list = SearchHistory();
  const actions = list.props.children[1][0].props.actions.props.children;
  expect(actions[0].props.title).toBe("Copy Dictation");
  const sectionForTrash = actions.at(-1);
  expect(sectionForTrash.type).toBe("actionSection");
  const destructive = sectionForTrash.props.children;
  expect(destructive.props).toMatchObject({
    title: "Move Transcript to Trash",
    shortcut: { modifiers: ["ctrl"], key: "k" },
  });
  expect(
    list.props.children[0].props.actions.props.children.some(
      (action: { type: unknown }) => action.type === "actionSection",
    ),
  ).toBe(false);
  action.trashTranscript.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await destructive.props.onAction();
  expect(result.revalidate).not.toHaveBeenCalled();
  await destructive.props.onAction();
  expect(action.trashTranscript).toHaveBeenCalledWith(result.data.entries[0]);
  expect(result.revalidate).toHaveBeenCalledOnce();
  action.enabled = false;
  expect(SearchHistory().props.children[1][0].props.actions.props.children[0].props.title).toBe("Copy Dictation");
  expect(SearchHistory().props.children[1][0].props.actions.props.children.at(-1)).toBe(false);
  action.enabled = true;
});
it("invalidates Return on a keystroke while the previous CLI reply is still visible to the hook", () => {
  const initial = SearchHistory();
  expect(initial.props.throttle).toBeFalsy();
  const firstActions = initial.props.children[1][0].props.actions.props.children;
  expect(firstActions[0].type).toBe("copy");
  expect(firstActions[0].props).toMatchObject({
    content: " exact final\n",
    concealed: true,
    shortcut: { modifiers: ["cmd"], key: "c" },
  });
  expect(firstActions[1].type).toBe("paste");
  expect(firstActions[1].props.content).toBe(" exact final\n");
  expect(firstActions[2].props).toMatchObject({ content: " raw\n", concealed: true });
  initial.props.onSearchTextChange("replacement");
  expect(SearchHistory().props.children[1]).toEqual([]);
  result.isLoading = true;
  expect(SearchHistory().props.children[1]).toEqual([]);
  result.data.query = "replacement";
  result.isLoading = false;
  expect(SearchHistory().props.children[1]).toHaveLength(1);
});
