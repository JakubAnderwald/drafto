"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "pane-collapse";

export interface PaneCollapseState {
  notebooks: boolean;
  notes: boolean;
}

export type PaneKey = keyof PaneCollapseState;

const DEFAULT_STATE: PaneCollapseState = { notebooks: false, notes: false };

function readStored(): PaneCollapseState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).notebooks === "boolean" &&
      typeof (parsed as Record<string, unknown>).notes === "boolean"
    ) {
      const value = parsed as PaneCollapseState;
      return { notebooks: value.notebooks, notes: value.notes };
    }
  } catch {
    // localStorage may be unavailable (e.g. private browsing, SSR)
  }
  return DEFAULT_STATE;
}

let listeners: Array<() => void> = [];
let currentState: PaneCollapseState = typeof window !== "undefined" ? readStored() : DEFAULT_STATE;

function subscribe(listener: () => void): () => void {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot(): PaneCollapseState {
  return currentState;
}

function getServerSnapshot(): PaneCollapseState {
  return DEFAULT_STATE;
}

function persist(next: PaneCollapseState) {
  currentState = next;
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // localStorage may be unavailable
  }
  listeners.forEach((l) => l());
}

export function usePaneCollapse() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const togglePane = useCallback((pane: PaneKey) => {
    persist({ ...currentState, [pane]: !currentState[pane] });
  }, []);

  const setPaneCollapsed = useCallback((pane: PaneKey, collapsed: boolean) => {
    persist({ ...currentState, [pane]: collapsed });
  }, []);

  return {
    notebooksCollapsed: state.notebooks,
    notesCollapsed: state.notes,
    togglePane,
    setPaneCollapsed,
  } as const;
}
