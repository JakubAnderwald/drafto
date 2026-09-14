import { afterEach, describe, expect, it } from "vitest";
import { shouldCloseOnEscape } from "@/app/(app)/admin/should-close-on-escape";

function keydown(key: string, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function mountPanel(): HTMLElement {
  const panel = document.createElement("div");
  document.body.appendChild(panel);
  return panel;
}

function mountButton(parent: HTMLElement): HTMLButtonElement {
  const button = document.createElement("button");
  parent.appendChild(button);
  return button;
}

describe("shouldCloseOnEscape", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("closes on Escape when focus is on the body", () => {
    const panel = mountPanel();

    expect(shouldCloseOnEscape(keydown("Escape"), panel)).toBe(true);
  });

  it("closes on Escape when focus is inside the panel", () => {
    const panel = mountPanel();
    const button = mountButton(panel);
    button.focus();

    expect(shouldCloseOnEscape(keydown("Escape", button), panel)).toBe(true);
  });

  it("closes on Escape dispatched on the document itself", () => {
    const panel = mountPanel();

    expect(shouldCloseOnEscape(keydown("Escape", document), panel)).toBe(true);
  });

  it("closes on Escape dispatched on the root html element", () => {
    const panel = mountPanel();

    expect(shouldCloseOnEscape(keydown("Escape", document.documentElement), panel)).toBe(true);
  });

  it("closes on Escape with no panel when focus is on the body", () => {
    expect(shouldCloseOnEscape(keydown("Escape"), null)).toBe(true);
  });

  it("ignores keys other than Escape", () => {
    const panel = mountPanel();

    expect(shouldCloseOnEscape(keydown("Enter"), panel)).toBe(false);
    expect(shouldCloseOnEscape(keydown("Esc"), panel)).toBe(false);
  });

  it("ignores an Escape another handler already handled", () => {
    const panel = mountPanel();
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    event.preventDefault();

    expect(shouldCloseOnEscape(event, panel)).toBe(false);
  });

  it.each(["input", "textarea"])("ignores Escape typed into an %s", (tagName) => {
    const panel = mountPanel();
    const field = document.createElement(tagName);
    panel.appendChild(field);
    field.focus();

    expect(shouldCloseOnEscape(keydown("Escape", field), panel)).toBe(false);
  });

  it("ignores Escape typed into a contentEditable element", () => {
    const panel = mountPanel();
    const editor = document.createElement("div");
    // jsdom doesn't implement isContentEditable.
    Object.defineProperty(editor, "isContentEditable", { value: true });
    panel.appendChild(editor);

    expect(shouldCloseOnEscape(keydown("Escape", editor), panel)).toBe(false);
  });

  it("ignores Escape when focus is outside the panel", () => {
    const panel = mountPanel();
    const sidebarButton = mountButton(document.body);
    sidebarButton.focus();

    expect(shouldCloseOnEscape(keydown("Escape", sidebarButton), panel)).toBe(false);
  });

  it("ignores Escape pressed outside the panel on an element that has since been removed", () => {
    // In a browser, React can unmount the focused element (the search overlay
    // closing on Escape) before this check runs, dropping focus to <body>.
    const panel = mountPanel();
    const overlayButton = mountButton(document.body);
    overlayButton.focus();
    const event = keydown("Escape", overlayButton);
    overlayButton.remove();

    expect(document.activeElement).toBe(document.body);
    expect(shouldCloseOnEscape(event, panel)).toBe(false);
  });

  it("ignores Escape when focus is outside the page and there is no panel", () => {
    const sidebarButton = mountButton(document.body);
    sidebarButton.focus();

    expect(shouldCloseOnEscape(keydown("Escape", sidebarButton), null)).toBe(false);
  });

  it("ignores Escape while a confirm dialog is open in the panel", () => {
    const panel = mountPanel();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    panel.appendChild(dialog);

    expect(shouldCloseOnEscape(keydown("Escape"), panel)).toBe(false);
  });

  it("ignores Escape while a dropdown menu is open anywhere on the page", () => {
    const panel = mountPanel();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);

    expect(shouldCloseOnEscape(keydown("Escape"), panel)).toBe(false);
  });
});
