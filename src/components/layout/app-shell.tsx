"use client";

import { useState } from "react";
import { NotebooksSidebar } from "@/components/notebooks/notebooks-sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar — notebooks */}
      <aside className="flex w-60 shrink-0 flex-col border-r bg-gray-50">
        <NotebooksSidebar
          selectedNotebookId={selectedNotebookId}
          onSelectNotebook={setSelectedNotebookId}
        />
      </aside>

      {/* Middle panel — note list */}
      <section className="flex w-72 shrink-0 flex-col border-r">
        {selectedNotebookId ? (
          children
        ) : (
          <div className="flex flex-1 items-center justify-center text-gray-400">
            Select a notebook
          </div>
        )}
      </section>

      {/* Main panel — editor */}
      <main className="flex flex-1 flex-col">
        <div className="flex flex-1 items-center justify-center text-gray-400">Select a note</div>
      </main>
    </div>
  );
}
