import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { Linking } from "react-native";
import type { Session, User } from "@supabase/supabase-js";
import { requestAccountDeletion, type AccountDeletionResult } from "@drafto/shared";

import { database } from "@/db";
import { syncDatabase, resetSyncState } from "@/db/sync";
import { getCachedApproval, setCachedApproval, clearCachedApproval } from "@/lib/approval-cache";
import { createRecoveryLinkHandler } from "@/lib/auth-recovery";
import { apiUrl } from "@/lib/config";
import { deleteAllLocalAttachments, processPendingUploads } from "@/lib/data";
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
  /**
   * True from the moment a password-recovery deep link is recognised until the
   * new password is saved (or the user backs out). A recovery link produces a
   * real session, so without this flag the route guard would drop the user into
   * the app — or the approval screen — and the reset screen would be
   * unreachable.
   */
  isRecovering: boolean;
  /** Why a recovery link could not be used (expired, already consumed, malformed). */
  recoveryError: string | null;
  /** Leaves recovery mode; called once the password has actually been changed. */
  endRecovery: () => void;
  signOut: () => Promise<void>;
  /**
   * Permanently deletes the signed-in user's account on the server. Only an `ok`
   * result signs out and wipes local data; any other result leaves the session
   * and the local database untouched so the user can retry.
   */
  deleteAccount: () => Promise<AccountDeletionResult>;
  refreshApprovalStatus: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isApproved, setIsApproved] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isCheckingApproval, setIsCheckingApproval] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const startRecovery = useCallback(() => {
    setIsRecovering(true);
    setRecoveryError(null);
  }, []);

  const failRecovery = useCallback((message: string) => {
    setIsRecovering(true);
    setRecoveryError(message);
  }, []);

  const endRecovery = useCallback(() => {
    setIsRecovering(false);
    setRecoveryError(null);
  }, []);

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

  /**
   * Clears the in-memory session and wipes everything this account left on the
   * device. Runs after the Supabase session has been ended, on both sign-out and
   * account deletion, so both give the same cross-account guarantees. Each step
   * is best-effort so one failure can't skip the others.
   */
  const resetLocalSession = useCallback(async (userId: string | undefined) => {
    setSession(null);
    setIsApproved(false);
    setIsRecovering(false);
    setRecoveryError(null);
    if (userId) {
      // Best-effort: a cache-clear failure must not skip the sync invalidation,
      // database reset, and attachment wipe below — those are the actual
      // cross-account guarantees — nor reject out of the caller.
      try {
        await clearCachedApproval(userId);
      } catch (error) {
        console.error("Failed to clear cached approval on sign-out:", error);
      }
    }

    // Invalidate any in-flight sync (e.g. a pre-sign-out flush that timed out but
    // is still running) so the next signed-in user starts a fresh sync instead
    // of coalescing onto this session's — which could otherwise write this
    // user's pulled records into the freshly-reset database below.
    resetSyncState();

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
  }, []);

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
    await resetLocalSession(userId);
  }, [session?.user?.id, resetLocalSession]);

  const deleteAccount = useCallback(async (): Promise<AccountDeletionResult> => {
    // Ask the client rather than React state: getSession() refreshes an expiring
    // access token, so the server receives one it will still accept.
    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession();
    const accessToken = currentSession?.access_token;
    if (!accessToken) return { status: "unauthorized" };

    const result = await requestAccountDeletion({ baseUrl: apiUrl, accessToken });
    if (result.status !== "ok") return result;

    // No pre-sign-out flush: the account and every server row are already gone,
    // so a sync would only fail and stall for up to FINAL_SYNC_TIMEOUT_MS.
    // Unsynced local edits are discarded on purpose. Local scope: deleteUser has
    // already ended the server sessions, so only this device's stored session
    // needs clearing; a global sign-out would ask the server to revoke every
    // session of a user that no longer exists. Best-effort — the account is gone
    // either way, so a failure here must not skip the local wipe below.
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch (error) {
      console.error("Local sign-out after account deletion failed:", error);
    }
    await resetLocalSession(currentSession.user.id);
    return result;
  }, [resetLocalSession]);

  // Password-recovery deep links. The flag has to flip the moment the link is
  // recognised — before the session lands — or the guard would route the user
  // into the app during the round-trip and the reset screen would never render.
  // The initial URL and later `url` events share one handler so their Supabase
  // session changes are serialized rather than racing each other.
  useEffect(() => {
    const recoveryLinks = createRecoveryLinkHandler({
      onRecoveryDetected: startRecovery,
      onRecoveryError: failRecovery,
    });

    const subscription = Linking.addEventListener("url", ({ url }) => recoveryLinks.handle(url));
    Linking.getInitialURL()
      .then((url) => {
        if (url) recoveryLinks.handle(url);
      })
      .catch((error) => {
        console.error("Failed to read the initial deep link:", error);
      });

    return () => {
      recoveryLinks.cancel();
      subscription.remove();
    };
  }, [startRecovery, failRecovery]);

  useEffect(() => {
    let mounted = true;

    supabase.auth
      .getSession()
      .then(({ data: { session: initialSession } }) => {
        if (!mounted) return;
        setSession(initialSession);
        if (initialSession?.user) {
          checkApproval(initialSession.user.id).finally(() => {
            if (mounted) setIsLoading(false);
          });
        } else {
          setIsLoading(false);
        }
      })
      .catch((error) => {
        console.error("Failed to get session:", error);
        if (mounted) setIsLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (!mounted) return;

      // supabase-js only emits PASSWORD_RECOVERY when it parses the recovery URL
      // itself (`detectSessionInUrl`), which is web-only here — the deep-link
      // handler above is what normally flips the flag. Handled anyway so a
      // future client-config change cannot silently bypass the reset screen.
      if (event === "PASSWORD_RECOVERY") {
        startRecovery();
      }

      setSession(newSession);
      if (newSession?.user) {
        checkApproval(newSession.user.id);
      } else {
        setIsApproved(false);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [checkApproval, startRecovery]);

  return (
    <AuthContext.Provider
      value={{
        user: session?.user ?? null,
        session,
        isApproved,
        isLoading,
        isCheckingApproval,
        isRecovering,
        recoveryError,
        endRecovery,
        signOut,
        deleteAccount,
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
