import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { Linking } from "react-native";
import Constants from "expo-constants";
import type { Session, User } from "@supabase/supabase-js";
import {
  requestAccountDeletion,
  withTimeout,
  type AccountDeletionResult,
  type AppleRevocationGrant,
} from "@drafto/shared";

import { database } from "@/db";
import { syncDatabase, resetSyncState } from "@/db/sync";
import { clearAccountDeletedNotice, reportAccountDeleted } from "@/lib/account-deleted-notice";
import { needsAppleConfirmation, requestAppleRevocationGrant } from "@/lib/apple-revocation";
import { getCachedApproval, setCachedApproval, clearCachedApproval } from "@/lib/approval-cache";
import { createRecoveryLinkHandler } from "@/lib/auth-recovery";
import { deleteAllLocalAttachments, processPendingUploads } from "@/lib/data/attachment-queue";
import { supabase } from "@/lib/supabase";

/** Max time to wait for the pre-sign-out flush before proceeding to reset. */
const FINAL_SYNC_TIMEOUT_MS = 10_000;

/** Production web origin, used when a build carries no `EXPO_PUBLIC_API_URL`. */
const DEFAULT_API_URL = "https://drafto.eu";

/** Origin of the web API that performs server-side account operations. */
function getApiUrl(): string {
  const configured: unknown = Constants.expoConfig?.extra?.apiUrl;
  return typeof configured === "string" && configured.length > 0 ? configured : DEFAULT_API_URL;
}

/** The client's current session; supabase-js refreshes it here if the access token expired. */
async function readClientSession(): Promise<Session | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session;
}

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

export interface SignOutOptions {
  /**
   * Skip the best-effort flush before the local wipe. For a caller that has just synced and
   * counted what is left itself, where a second attempt would only repeat a known result.
   */
  skipFinalSync?: boolean;
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
  signOut: (options?: SignOutOptions) => Promise<void>;
  /**
   * Permanently deletes the signed-in account on the server. Local data is wiped
   * and the user signed out only when the server confirms (`status: "ok"`); any
   * other result leaves the session and the offline database untouched. On iOS an
   * Apple-linked user is first asked to confirm with Apple, so the server can revoke
   * their Sign in with Apple tokens.
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
  // The user the last approval check found approved. Their hourly token refresh need not
  // re-check: approval is what lets them work, and RLS still enforces it on the server. An
  // unapproved user is re-checked on refresh, which picks up an approval (or retries a check
  // that failed offline) without them pressing "Check approval status".
  const approvedUserIdRef = useRef<string | null>(null);
  // Bumped by every approval check and by every session end. Only the latest check may decide
  // approval: a slow check for an account that was signed out or replaced meanwhile (e.g. a
  // second sign-in from the still-visible login screen) must not route the new session.
  const approvalCheckRef = useRef(0);

  /** Drops any approval check in flight; for a session that just ended. */
  const abandonApprovalCheck = useCallback(() => {
    approvalCheckRef.current += 1;
    approvedUserIdRef.current = null;
    setIsCheckingApproval(false);
  }, []);

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
    const check = ++approvalCheckRef.current;
    const isLatest = () => check === approvalCheckRef.current;
    const settle = (approved: boolean) => {
      if (!isLatest()) return;
      approvedUserIdRef.current = approved ? userId : null;
      setIsApproved(approved);
    };

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
        settle(approved);
        return approved;
      }

      const approved = profile?.is_approved === true;
      settle(approved);
      try {
        await setCachedApproval(userId, approved);
      } catch {
        // Cache write failed — non-fatal
      }
      return approved;
    } finally {
      if (isLatest()) setIsCheckingApproval(false);
    }
  }, []);

  const refreshApprovalStatus = useCallback(async (): Promise<boolean> => {
    if (session?.user) {
      return checkApproval(session.user.id);
    }
    return false;
  }, [session?.user, checkApproval]);

  /**
   * Clears the in-memory session and every trace of the account on this device.
   * Runs after the Supabase session has been ended, on both sign-out and account
   * deletion. Each step is best-effort so one failure can't skip the others.
   */
  const resetLocalSession = useCallback(
    async (userId: string | undefined) => {
      abandonApprovalCheck();
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

      // Invalidate any in-flight sync (e.g. a final sync that timed out before
      // sign-out but is still running) so the next signed-in user starts a fresh
      // sync instead of coalescing onto this session's — which could otherwise
      // write this user's pulled records into the freshly-reset database below.
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
    },
    [abandonApprovalCheck],
  );

  const signOut = useCallback(
    async (options?: SignOutOptions) => {
      const userId = session?.user?.id;

      // Best-effort: flush unsynced local changes while the session is still valid.
      // A failed, offline, or slow sync must never block sign-out, so it is bounded
      // by a timeout and its errors are swallowed.
      if (!options?.skipFinalSync) {
        const settled = await withTimeout(
          flushPendingChanges().then(
            () => true,
            (error: unknown) => {
              console.warn("Final sync before sign-out failed:", error);
              return true;
            },
          ),
          FINAL_SYNC_TIMEOUT_MS,
          false,
        );
        if (!settled) console.warn("Final sync before sign-out timed out");
      }

      await supabase.auth.signOut();
      await resetLocalSession(userId);
    },
    [session?.user?.id, resetLocalSession],
  );

  const deleteAccount = useCallback(async (): Promise<AccountDeletionResult> => {
    // Read the session from the client rather than React state so the request
    // carries the freshest access token (autoRefreshToken may have rotated it).
    let currentSession = await readClientSession();
    if (!currentSession?.access_token) return { status: "unauthorized" };

    // An Apple-linked iOS user confirms with Apple for a fresh code, which the server revokes
    // once the account is gone (App Store guideline 5.1.1(v)). Null when the user cancels or
    // Apple fails: the deletion goes ahead either way. Apple's sheet can stay open a while, so
    // the session is read again afterwards and a token that expired meanwhile is refreshed.
    let appleRevocation: AppleRevocationGrant | null = null;
    if (needsAppleConfirmation(currentSession.user)) {
      const confirmedUserId = currentSession.user.id;
      appleRevocation = await requestAppleRevocationGrant(currentSession.user);
      currentSession = await readClientSession();
      // Only the account the user confirmed may be deleted. Something that switched the
      // session while the sheet was open, such as a password-recovery link, stops it here.
      if (!currentSession?.access_token || currentSession.user.id !== confirmedUserId) {
        return { status: "unauthorized" };
      }
    }

    const result = await requestAccountDeletion({
      baseUrl: getApiUrl(),
      accessToken: currentSession.access_token,
      ...(appleRevocation ? { appleRevocation } : {}),
    });
    // Anything short of a confirmed deletion keeps the user signed in with their
    // offline data intact, so they can retry or keep working.
    if (result.status !== "ok") return result;

    // Set before the session clears, so the login screen the route guard opens next already
    // carries the confirmation.
    reportAccountDeleted();

    // No pre-sign-out flush here, unlike signOut(): the account and all of its
    // rows are already gone, so a sync would only fail with 401s and stall for up
    // to FINAL_SYNC_TIMEOUT_MS before the reset. Unsynced local edits are
    // discarded on purpose.
    //
    // `local` scope: deleting the user already ended every server session, so
    // only this device's stored session needs clearing. The default global scope
    // would ask the server to revoke all sessions of a user that no longer
    // exists. Best-effort — the account is gone either way, so a failure here
    // must not skip the local wipe below.
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
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      // The deep-link handler above flips the flag first, the moment a recovery
      // link arrives, so the route guard holds the reset screen during the
      // exchange. Under PKCE (ADR-0045) the exchange then also emits
      // PASSWORD_RECOVERY for a recovery code; handling it keeps the reset screen
      // in place even if a recovery session ever arrives another way.
      if (event === "PASSWORD_RECOVERY") {
        startRecovery();
      }

      // A new sign-in makes an earlier "account deleted" confirmation stale.
      if (event === "SIGNED_IN") {
        clearAccountDeletedNotice();
      }

      setSession(newSession);
      if (!newSession?.user) {
        abandonApprovalCheck();
        setIsApproved(false);
        return;
      }
      // The hourly token refresh only swaps tokens, so an approved user is not re-checked
      // under whatever screen is open. An unapproved one still is (see approvedUserIdRef).
      if (event === "TOKEN_REFRESHED" && newSession.user.id === approvedUserIdRef.current) {
        return;
      }
      checkApproval(newSession.user.id);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [checkApproval, startRecovery, abandonApprovalCheck]);

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
