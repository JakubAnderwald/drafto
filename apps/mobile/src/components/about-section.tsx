import { useMemo } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { PRIVACY_POLICY_URL, SUPPORT_URL } from "@drafto/shared";

import { getAppVersionLabel } from "@/lib/app-version";
import { openExternalUrl } from "@/lib/open-external-url";
import { useTheme } from "@/providers/theme-provider";
import { fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

interface AboutLink {
  label: string;
  url: string;
  icon: keyof typeof Ionicons.glyphMap;
  testID: string;
}

const ABOUT_LINKS: readonly AboutLink[] = [
  {
    label: "Privacy policy",
    url: PRIVACY_POLICY_URL,
    icon: "shield-checkmark-outline",
    testID: "about-privacy",
  },
  { label: "Support", url: SUPPORT_URL, icon: "help-circle-outline", testID: "about-support" },
];

async function openLink(link: AboutLink): Promise<void> {
  if (await openExternalUrl(link.url)) return;
  Alert.alert("Couldn't open the page", `Open ${link.url} in your browser.`);
}

/**
 * Settings → About (PrimeTestLab 11035 S-01): the app's version and build, and links to the
 * privacy policy and the support page on drafto.eu.
 */
export function AboutSection() {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const version = useMemo(() => getAppVersionLabel(), []);

  return (
    <View style={styles.card} testID="about-section">
      <View
        style={styles.row}
        accessible
        accessibilityLabel={`Version ${version}`}
        testID="about-version"
      >
        <Ionicons name="information-circle-outline" size={20} color={semantic.fgMuted} />
        <Text style={styles.label}>Version</Text>
        <Text style={styles.value} selectable>
          {version}
        </Text>
      </View>
      {ABOUT_LINKS.map((link) => (
        <Pressable
          key={link.testID}
          style={({ pressed }) => [styles.row, styles.divided, pressed && styles.rowPressed]}
          onPress={() => {
            void openLink(link);
          }}
          accessibilityRole="link"
          accessibilityLabel={link.label}
          accessibilityHint="Opens drafto.eu in the browser"
          testID={link.testID}
        >
          <Ionicons name={link.icon} size={20} color={semantic.fgMuted} />
          <Text style={styles.label}>{link.label}</Text>
          <Ionicons name="open-outline" size={16} color={semantic.fgSubtle} />
        </Pressable>
      ))}
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: semantic.bg,
      borderRadius: radii.lg,
      overflow: "hidden",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      minHeight: 48,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
    },
    divided: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: semantic.border,
    },
    rowPressed: {
      backgroundColor: semantic.bgSubtle,
    },
    label: {
      flex: 1,
      fontSize: fontSizes.lg,
      color: semantic.fg,
    },
    value: {
      fontSize: fontSizes.md,
      color: semantic.fgMuted,
    },
  });
