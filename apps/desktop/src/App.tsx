import React from "react";

import { ThemeProvider } from "@/providers/theme-provider";
import { MenuProvider } from "@/providers/menu-provider";
import { AuthProvider } from "@/providers/auth-provider";
import { DatabaseProvider } from "@/providers/database-provider";
import { RootNavigator } from "@/navigation/app-navigator";

export function App() {
  return (
    <ThemeProvider>
      <MenuProvider>
        <AuthProvider>
          <DatabaseProvider>
            <RootNavigator />
          </DatabaseProvider>
        </AuthProvider>
      </MenuProvider>
    </ThemeProvider>
  );
}
