import { createContext, useContext, useEffect, useRef, useCallback } from "react";
import type { Database } from "@nozbe/watermelondb";

import { database } from "@/db";
import { syncDatabase } from "@/db/sync";
import { useAuth } from "@/providers/auth-provider";

interface DatabaseContextValue {
  database: Database;
  sync: () => Promise<void>;
}

const DatabaseContext = createContext<DatabaseContextValue | null>(null);

export function DatabaseProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const syncingRef = useRef(false);

  const sync = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      await syncDatabase(database);
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      syncingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (user) {
      sync();
    }
  }, [user, sync]);

  return <DatabaseContext.Provider value={{ database, sync }}>{children}</DatabaseContext.Provider>;
}

export function useDatabase(): DatabaseContextValue {
  const context = useContext(DatabaseContext);
  if (!context) {
    throw new Error("useDatabase must be used within a DatabaseProvider");
  }
  return context;
}
