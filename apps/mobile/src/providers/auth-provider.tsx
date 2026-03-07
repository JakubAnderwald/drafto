import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { supabase } from "@/lib/supabase";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  isApproved: boolean;
  isLoading: boolean;
  signOut: () => Promise<void>;
  refreshApprovalStatus: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isApproved, setIsApproved] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const checkApproval = useCallback(async (userId: string) => {
    const { data: profile } = await supabase
      .from("profiles")
      .select("is_approved")
      .eq("id", userId)
      .single();

    setIsApproved(profile?.is_approved === true);
  }, []);

  const refreshApprovalStatus = useCallback(async () => {
    if (session?.user) {
      await checkApproval(session.user.id);
    }
  }, [session?.user, checkApproval]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setSession(null);
    setIsApproved(false);
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
