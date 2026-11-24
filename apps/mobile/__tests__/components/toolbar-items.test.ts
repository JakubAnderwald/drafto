import type { ArgsToolbarCB, ToolbarItem } from "@10play/tentap-editor";

import {
  focusingToolbarItem,
  NOTE_HEADING_ITEMS,
  NOTE_TOOLBAR_ITEMS,
} from "@/components/editor/toolbar-items";

const mockCalls: string[] = [];

function mockItem(label: string): ToolbarItem {
  return {
    onPress: () => () => {
      mockCalls.push(`press:${label}`);
    },
    active: () => false,
    disabled: ({ editorState }) => !(editorState as { canUndo?: boolean }).canUndo,
    image: () => label,
    label,
  };
}

jest.mock("@10play/tentap-editor", () => ({
  DEFAULT_TOOLBAR_ITEMS: ["Bold", "Link", "Heading", "Undo"].map(mockItem),
  HEADING_ITEMS: ["Close headings", "Heading 1"].map(mockItem),
}));

function argsFor(isFocused: boolean, canUndo = true): ArgsToolbarCB {
  return {
    editor: {
      focus: () => {
        mockCalls.push("focus");
      },
    },
    editorState: { isFocused, canUndo },
    setToolbarContext: jest.fn(),
    toolbarContext: 0,
  } as unknown as ArgsToolbarCB;
}

function press(items: ToolbarItem[], label: string, args: ArgsToolbarCB): void {
  const item = items.find((candidate) => candidate.label === label);
  if (!item) throw new Error(`no ${label} item`);
  item.onPress(args)();
}

beforeEach(() => {
  mockCalls.length = 0;
});

describe("PrimeTestLab 11035 E2E note toolbar items", () => {
  it("focuses a blurred editor before a formatting button applies", () => {
    // Android: without the native focus, the format was set but no keyboard
    // came up and typing went nowhere.
    press(NOTE_TOOLBAR_ITEMS, "Bold", argsFor(false));

    expect(mockCalls).toEqual(["focus", "press:Bold"]);
  });

  it("leaves a focused editor's focus alone", () => {
    press(NOTE_TOOLBAR_ITEMS, "Bold", argsFor(true));

    expect(mockCalls).toEqual(["press:Bold"]);
  });

  it.each(["Link", "Heading"])("lets %s only switch the toolbar, without focusing", (label) => {
    press(NOTE_TOOLBAR_ITEMS, label, argsFor(false));

    expect(mockCalls).toEqual([`press:${label}`]);
  });

  it("focuses for a heading level, but not for closing the heading row", () => {
    press(NOTE_HEADING_ITEMS, "Heading 1", argsFor(false));
    press(NOTE_HEADING_ITEMS, "Close headings", argsFor(false));

    expect(mockCalls).toEqual(["focus", "press:Heading 1", "press:Close headings"]);
  });

  it("keeps TenTap's disabled state, so undo stays disabled with nothing to undo", () => {
    const undo = NOTE_TOOLBAR_ITEMS.find((item) => item.label === "Undo");

    expect(undo?.disabled(argsFor(false, false))).toBe(true);
    expect(undo?.disabled(argsFor(false, true))).toBe(false);
  });

  it("keeps every item, in TenTap's order", () => {
    expect(NOTE_TOOLBAR_ITEMS.map((item) => item.label)).toEqual([
      "Bold",
      "Link",
      "Heading",
      "Undo",
    ]);
    expect(NOTE_HEADING_ITEMS.map((item) => item.label)).toEqual(["Close headings", "Heading 1"]);
  });

  it("returns an item without a label unchanged apart from the focus", () => {
    const unlabelled: ToolbarItem = { ...mockItem("x"), label: undefined };

    focusingToolbarItem(unlabelled).onPress(argsFor(false))();

    expect(mockCalls).toEqual(["focus", "press:x"]);
  });
});
