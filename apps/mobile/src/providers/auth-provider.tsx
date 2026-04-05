import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { getCachedApproval, setCachedApproval, clearCachedApproval } from "@/lib/approval-cache";
import { supabase } from "@/lib/supabase";

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
          const cached = await getCachedApproval();
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
        await setCachedApproval(approved);
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
    await supabase.auth.signOut();
    setSession(null);
    setIsApproved(false);
    await clearCachedApproval();
  }, []);

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
