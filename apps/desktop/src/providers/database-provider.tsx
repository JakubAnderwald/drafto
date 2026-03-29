import React, { createContext, useContext } from "react";
import type { Database as WMDatabase } from "@nozbe/watermelondb";

import { database } from "@/db";

interface DatabaseContextValue {
  database: WMDatabase;
}

const DatabaseContext = createContext<DatabaseContextValue | null>(null);

export function DatabaseProvider({ children }: { children: React.ReactNode }) {
  return <DatabaseContext.Provider value={{ database }}>{children}</DatabaseContext.Provider>;
}

export function useDatabase(): DatabaseContextValue {
  const context = useContext(DatabaseContext);
  if (!context) {
    throw new Error("useDatabase must be used within a DatabaseProvider");
  }
  return context;
}
