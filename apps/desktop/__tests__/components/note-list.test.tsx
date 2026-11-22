import { View } from "react-native";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import { NoteList } from "@/components/notes/note-list";

jest.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: { id: "user-1", email: "user@example.com" } }),
}));

type NoteDraft = { isTrashed: boolean; trashedAt: Date | null };
interface MockNote {
  id: string;
  title: string;
  updatedAt: Date;
  draft: NoteDraft;
  update: jest.Mock;
}

const mockNotes: MockNote[] = [];
jest.mock("@/hooks/use-notes", () => ({
  useNotes: () => ({ notes: mockNotes, loading: false }),
}));

const mockWrite = jest.fn(async (fn: () => Promise<void>) => {
  await fn();
});
jest.mock("@/db", () => ({
  database: {
    get: jest.fn(),
    write: (fn: () => Promise<void>) => mockWrite(fn),
  },
}));

function addNote(id: string, title: string): MockNote {
  const draft: NoteDraft = { isTrashed: false, trashedAt: null };
  const note: MockNote = {
    id,
    title,
    updatedAt: new Date("2026-11-01T10:00:00Z"),
    draft,
    update: jest.fn(async (fn: (n: NoteDraft) => void) => fn(draft)),
  };
  mockNotes.push(note);
  return note;
}

function renderList(
  onSelectNote: (id: string) => void = jest.fn(),
  selectedNoteId: string | undefined = undefined,
) {
  return render(
    <NoteList notebookId="nb-1" selectedNoteId={selectedNoteId} onSelectNote={onSelectNote} />,
  );
}

describe("NoteList — delete without a mouse (#864)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotes.length = 0;
  });

  it("exposes a named Delete note action on each row for VoiceOver", () => {
    addNote("n-1", "Groceries");
    addNote("n-2", "Ideas");
    const utils = renderList();

    for (const title of ["Groceries", "Ideas"]) {
      expect(utils.getByLabelText(title).props.accessibilityActions).toEqual([
        { name: "Delete note", label: "Delete note" },
      ]);
    }
  });

  it("moves the note to Trash when VoiceOver runs the action", async () => {
    const note = addNote("n-1", "Groceries");
    const other = addNote("n-2", "Ideas");
    const utils = renderList();

    fireEvent(utils.getByLabelText("Groceries"), "accessibilityAction", {
      nativeEvent: { actionName: "Delete note" },
    });

    await waitFor(() => expect(note.update).toHaveBeenCalledTimes(1));
    expect(note.draft.isTrashed).toBe(true);
    expect(note.draft.trashedAt).toBeInstanceOf(Date);
    expect(other.update).not.toHaveBeenCalled();
  });

  it("moves the focused, selected note to Trash on the Delete key", async () => {
    const note = addNote("n-1", "Groceries");
    const utils = renderList(jest.fn(), "n-1");

    fireEvent(utils.getByLabelText("Groceries"), "keyDown", {
      nativeEvent: { key: "Backspace" },
    });

    await waitFor(() => expect(note.update).toHaveBeenCalledTimes(1));
    expect(note.draft.isTrashed).toBe(true);
  });

  it("leaves the note alone on other keys", () => {
    const note = addNote("n-1", "Groceries");
    const utils = renderList(jest.fn(), "n-1");
    const row = utils.getByLabelText("Groceries");

    fireEvent(row, "keyDown", { nativeEvent: { key: "a" } });
    fireEvent(row, "keyDown", { nativeEvent: { key: "Backspace", shiftKey: true } });

    expect(note.update).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("selects the note on press and gives its row keyboard focus, so ⌫ reaches it", () => {
    addNote("n-1", "Groceries");
    const onSelectNote = jest.fn();
    // In jest the row's ref is react-native's mocked View; its focus() stands in for the
    // native focus command.
    const focus = jest.spyOn(
      (View as unknown as { prototype: { focus: () => void } }).prototype,
      "focus",
    );
    const utils = renderList(onSelectNote);

    fireEvent.press(utils.getByLabelText("Groceries"));

    expect(onSelectNote).toHaveBeenCalledWith("n-1");
    expect(focus).toHaveBeenCalledTimes(1);
    focus.mockRestore();
  });

  it("ignores ⌫ on a row that kept focus after another note was selected", () => {
    const stale = addNote("n-1", "Groceries");
    addNote("n-2", "Ideas");
    const utils = renderList(jest.fn(), "n-2");

    fireEvent(utils.getByLabelText("Groceries"), "keyDown", {
      nativeEvent: { key: "Backspace" },
    });

    expect(stale.update).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
