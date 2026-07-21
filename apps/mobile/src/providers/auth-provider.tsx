import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { database } from "@/db";
import { syncDatabase } from "@/db/sync";
import { getCachedApproval, setCachedApproval, clearCachedApproval } from "@/lib/approval-cache";
import { deleteAllLocalAttachments, processPendingUploads } from "@/lib/data/attachment-queue";
import { supabase } from "@/lib/supabase";

/** Max time to wait for the pre-sign-out flush before proceeding to reset. */
const FINAL_SYNC_TIMEOUT_MS = 10_000;

/**
 * Best-effort flush of unsynced local changes while the session is still valid.
 * Attachment uploads and metadata sync are independent — an upload failure must
 * not stop the metadata push.
 */
async function flushPendingChanges(): Promise<void> {
  try {
    await processPendingUploads();
  } catch (error) {
    console.warn("Attachment upload before sign-out failed:", error);
  }
  await syncDatabase(database);
}

/** Rejects if `promise` has not settled within `ms` milliseconds. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Operation timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  isApproved: boolean;
  isLoading: boolean;
  isCheckingApproval: boolean;
  signOut: () => Promise<void>;
  refreshApprovalStatus: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isApproved, setIsApproved] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isCheckingApproval, setIsCheckingApproval] = useState(false);

  const checkApproval = useCallback(async (userId: string): Promise<boolean> => {
    setIsCheckingApproval(true);
    try {
      const { data: profile, error } = await supabase
        .from("profiles")
        .select("is_approved")
        .eq("id", userId)
        .single();

      if (error) {
        // Network failure — fall back to cached approval status
        let approved = false;
        try {
          const cached = await getCachedApproval(userId);
          approved = cached === true;
        } catch {
          // Storage unavailable — default to not approved
        }
        setIsApproved(approved);
        return approved;
      }

      const approved = profile?.is_approved === true;
      setIsApproved(approved);
      try {
        await setCachedApproval(userId, approved);
      } catch {
        // Cache write failed — non-fatal
      }
      return approved;
    } finally {
      setIsCheckingApproval(false);
    }
  }, []);

  const refreshApprovalStatus = useCallback(async (): Promise<boolean> => {
    if (session?.user) {
      return checkApproval(session.user.id);
    }
    return false;
  }, [session?.user, checkApproval]);

  const signOut = useCallback(async () => {
    const userId = session?.user?.id;

    // Best-effort: flush unsynced local changes while the session is still valid.
    // A failed, offline, or slow sync must never block sign-out, so it is bounded
    // by a timeout and its errors are swallowed.
    try {
      await withTimeout(flushPendingChanges(), FINAL_SYNC_TIMEOUT_MS);
    } catch (error) {
      console.warn("Final sync before sign-out failed or timed out:", error);
    }

    await supabase.auth.signOut();
    setSession(null);
    setIsApproved(false);
    if (userId) {
      await clearCachedApproval(userId);
    }

    // Wipe the offline cache so a different account/environment starts clean and
    // stale notes can't carry across logins. Best-effort: a reset failure must
    // not block sign-out.
    try {
      await database.write(() => database.unsafeResetDatabase());
    } catch (error) {
      console.error("Failed to reset local database on sign-out:", error);
    }

    // Delete locally cached attachment files so they can't leak to the next
    // account. Best-effort: file-deletion failures must not block sign-out.
    try {
      await deleteAllLocalAttachments();
    } catch (error) {
      console.error("Failed to delete local attachments on sign-out:", error);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session: initialSession } }) => {
      setSession(initialSession);
      if (initialSession?.user) {
        checkApproval(initialSession.user.id).finally(() => setIsLoading(false));
      } else {
        setIsLoading(false);
      }
    });

    // Listen for auth state changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (newSession?.user) {
        checkApproval(newSession.user.id);
      } else {
        setIsApproved(false);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [checkApproval]);

  return (
    <AuthContext.Provider
      value={{
        user: session?.user ?? null,
        session,
        isApproved,
        isLoading,
        isCheckingApproval,
        signOut,
        refreshApprovalStatus,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
