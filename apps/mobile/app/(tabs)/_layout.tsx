import { Tabs, useRouter } from "expo-router";
import { Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "@/providers/theme-provider";
import { colors } from "@/theme/tokens";

export default function TabsLayout() {
  const { semantic } = useTheme();
  const router = useRouter();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary[600],
        tabBarInactiveTintColor: semantic.fgSubtle,
        tabBarStyle: {
          backgroundColor: semantic.bg,
          borderTopColor: semantic.border,
        },
        headerStyle: { backgroundColor: semantic.bg },
        headerTintColor: semantic.fg,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Notebooks",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="book-outline" size={size} color={color} />
          ),
          headerRight: () => (
            <Pressable onPress={() => router.push("/search")} style={{ marginRight: 16 }}>
              <Ionicons name="search-outline" size={22} color={semantic.fg} />
            </Pressable>
          ),
        }}
      />
      <Tabs.Screen
        name="trash"
        options={{
          title: "Trash",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="trash-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
