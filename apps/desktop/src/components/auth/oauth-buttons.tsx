import { useState, useMemo } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Platform } from "react-native";
import Svg, { Path } from "react-native-svg";

import { useTheme } from "@/providers/theme-provider";
import { fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { signInWithOAuthBrowser } from "@/lib/oauth";

type OAuthProvider = "google" | "apple";

// react-native-svg renders as 0x0 on react-native-macos, so we fall back to
// text-based icons there. Other platforms keep the branded SVG.
const IS_MACOS = Platform.OS === "macos";

function GoogleIcon() {
  if (IS_MACOS) {
    return (
      <View style={googleFallback.wrap}>
        <Text style={googleFallback.letter}>G</Text>
      </View>
    );
  }
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <Path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <Path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <Path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </Svg>
  );
}

function AppleIcon({ color }: { color: string }) {
  if (IS_MACOS) {
    // U+F8FF is the Apple logo glyph in Apple system fonts — renders natively on macOS.
    return <Text style={[appleFallback.glyph, { color }]}>{""}</Text>;
  }
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill={color}>
      <Path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </Svg>
  );
}

const googleFallback = StyleSheet.create({
  wrap: {
    width: 20,
    height: 20,
    borderRadius: radii.sm,
    // eslint-disable-next-line no-restricted-syntax -- Google brand white
    backgroundColor: "#ffffff",
    borderWidth: 1,
    // eslint-disable-next-line no-restricted-syntax -- Google brand outline
    borderColor: "#DADCE0",
    alignItems: "center",
    justifyContent: "center",
  },
  letter: {
    fontSize: fontSizes.md,
    fontWeight: "700",
    // eslint-disable-next-line no-restricted-syntax -- Google brand blue
    color: "#4285F4",
    lineHeight: 16,
  },
});

const appleFallback = StyleSheet.create({
  glyph: {
    fontSize: fontSizes["2xl"],
    lineHeight: 20,
    width: 20,
    textAlign: "center",
  },
});

interface OAuthButtonsProps {
  onError?: (error: string) => void;
}

export function OAuthButtons({ onError }: OAuthButtonsProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const [loadingProvider, setLoadingProvider] = useState<OAuthProvider | null>(null);

  const handleOAuth = async (provider: OAuthProvider) => {
    setLoadingProvider(provider);

    const result = await signInWithOAuthBrowser(provider);

    if (result.error) {
      onError?.(result.error);
    }

    setLoadingProvider(null);
  };

  return (
    <View style={styles.container}>
      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or continue with</Text>
        <View style={styles.dividerLine} />
      </View>

      <Pressable
        style={({ pressed }) => [
          styles.oauthButton,
          pressed && styles.oauthButtonPressed,
          loadingProvider !== null && styles.oauthButtonDisabled,
        ]}
        onPress={() => handleOAuth("google")}
        disabled={loadingProvider !== null}
        accessibilityRole="button"
        accessibilityLabel="Sign in with Google"
      >
        {loadingProvider === "google" ? (
          <ActivityIndicator color={semantic.fg} size="small" />
        ) : (
          <>
            <GoogleIcon />
            <Text style={styles.oauthButtonText}>Google</Text>
          </>
        )}
      </Pressable>

      <Pressable
        style={({ pressed }) => [
          styles.oauthButton,
          pressed && styles.oauthButtonPressed,
          loadingProvider !== null && styles.oauthButtonDisabled,
        ]}
        onPress={() => handleOAuth("apple")}
        disabled={loadingProvider !== null}
        accessibilityRole="button"
        accessibilityLabel="Sign in with Apple"
      >
        {loadingProvider === "apple" ? (
          <ActivityIndicator color={semantic.fg} size="small" />
        ) : (
          <>
            <AppleIcon color={semantic.fg} />
            <Text style={styles.oauthButtonText}>Apple</Text>
          </>
        )}
      </Pressable>
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      width: "100%",
      marginTop: spacing.lg,
      gap: spacing.md,
    },
    dividerRow: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: spacing.xs,
    },
    dividerLine: {
      flex: 1,
      height: 1,
      backgroundColor: semantic.border,
    },
    dividerText: {
      marginHorizontal: spacing.md,
      fontSize: fontSizes.md,
      color: semantic.fgMuted,
    },
    oauthButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.md,
      borderWidth: 1,
      borderColor: semantic.borderStrong,
      borderRadius: radii.md,
      padding: spacing.lg,
      backgroundColor: semantic.bg,
    },
    oauthButtonPressed: {
      backgroundColor: semantic.bgMuted,
    },
    oauthButtonDisabled: {
      opacity: 0.5,
    },
    oauthButtonText: {
      fontSize: fontSizes.xl,
      fontWeight: "500",
      color: semantic.fg,
    },
  });
