import { View } from "react-native";

interface EyeIconProps {
  size?: number;
  color: string;
  /** Draws a diagonal bar across the eye ("hide"). */
  slashed?: boolean;
}

// View-based eye to avoid the 0×0 react-native-svg rendering bug on RN macOS:
// an outlined almond (a stadium), a filled pupil, and an optional 45° slash.
export function EyeIcon({ size = 18, color, slashed = false }: EyeIconProps) {
  const stroke = Math.max(1.5, size / 11);
  const eyeHeight = size * 0.62;
  const pupil = size * 0.3;
  const slashLength = size * 1.1;
  return (
    <View
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
      testID={slashed ? "eye-icon-slashed" : "eye-icon"}
    >
      <View
        style={{
          position: "absolute",
          top: (size - eyeHeight) / 2,
          left: 0,
          width: size,
          height: eyeHeight,
          borderRadius: eyeHeight / 2,
          borderWidth: stroke,
          borderColor: color,
        }}
      />
      <View
        style={{
          width: pupil,
          height: pupil,
          borderRadius: pupil / 2,
          backgroundColor: color,
        }}
      />
      {slashed ? (
        <View
          testID="eye-icon-slash"
          style={{
            position: "absolute",
            top: (size - stroke) / 2,
            left: (size - slashLength) / 2,
            width: slashLength,
            height: stroke,
            borderRadius: stroke / 2,
            backgroundColor: color,
            transform: [{ rotate: "45deg" }],
          }}
        />
      ) : null}
    </View>
  );
}
