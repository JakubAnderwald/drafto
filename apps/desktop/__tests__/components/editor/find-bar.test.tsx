import { render, screen, fireEvent } from "../../helpers/test-utils";
import { FindBar } from "@/components/editor/find-bar";

const baseProps = {
  query: "",
  match: { current: 0, total: 0 },
  onChangeQuery: jest.fn(),
  onNext: jest.fn(),
  onPrev: jest.fn(),
  onClose: jest.fn(),
  focusSignal: 0,
};

describe("FindBar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the find input", () => {
    render(<FindBar {...baseProps} />);
    expect(screen.getByPlaceholderText("Find in note")).toBeTruthy();
  });

  it("shows the match count when there are results", () => {
    render(<FindBar {...baseProps} query="foo" match={{ current: 3, total: 12 }} />);
    expect(screen.getByText("3/12")).toBeTruthy();
  });

  it('shows "No results" for a non-empty query with no matches', () => {
    render(<FindBar {...baseProps} query="zzz" match={{ current: 0, total: 0 }} />);
    expect(screen.getByText("No results")).toBeTruthy();
  });

  it("shows no count for an empty query", () => {
    render(<FindBar {...baseProps} query="" />);
    expect(screen.queryByText("No results")).toBeNull();
  });

  it("calls onChangeQuery as the user types", () => {
    const onChangeQuery = jest.fn();
    render(<FindBar {...baseProps} onChangeQuery={onChangeQuery} />);
    fireEvent.changeText(screen.getByPlaceholderText("Find in note"), "hello");
    expect(onChangeQuery).toHaveBeenCalledWith("hello");
  });

  it("steps with the next / previous buttons", () => {
    const onNext = jest.fn();
    const onPrev = jest.fn();
    render(
      <FindBar
        {...baseProps}
        query="foo"
        match={{ current: 1, total: 3 }}
        onNext={onNext}
        onPrev={onPrev}
      />,
    );
    fireEvent.press(screen.getByLabelText("Next match"));
    fireEvent.press(screen.getByLabelText("Previous match"));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("closes with the close button", () => {
    const onClose = jest.fn();
    render(<FindBar {...baseProps} onClose={onClose} />);
    fireEvent.press(screen.getByLabelText("Close find"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("steps to the next match on Return and keeps the input focused", () => {
    const onNext = jest.fn();
    const onPrev = jest.fn();
    const onClose = jest.fn();
    render(
      <FindBar
        {...baseProps}
        query="foo"
        match={{ current: 1, total: 3 }}
        onNext={onNext}
        onPrev={onPrev}
        onClose={onClose}
      />,
    );
    const input = screen.getByPlaceholderText("Find in note");
    expect(input.props.submitBehavior).toBe("submit");
    // The mocked TextInput's `focus` is what `inputRef.current.focus()` calls.
    const [mockInput] = screen.UNSAFE_root.findAll(
      (node) => node.props.placeholder === "Find in note" && typeof node.type !== "string",
    );
    const instance = mockInput.instance as { focus: jest.Mock; setSelection: jest.Mock };
    instance.focus.mockClear();
    instance.setSelection.mockClear();
    fireEvent(input, "submitEditing", { nativeEvent: { text: "foo" } });
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(instance.focus).toHaveBeenCalledTimes(1);
    // Caret at the end, not AppKit's select-all on refocus, so typing refines the query.
    expect(instance.setSelection).toHaveBeenCalledWith(3, 3);
  });

  it("closes on Escape, which macOS reports as a keyPress", () => {
    const onClose = jest.fn();
    render(<FindBar {...baseProps} onClose={onClose} />);
    const input = screen.getByPlaceholderText("Find in note");
    fireEvent(input, "keyPress", { nativeEvent: { key: "a" } });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent(input, "keyPress", { nativeEvent: { key: "Escape" } });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
