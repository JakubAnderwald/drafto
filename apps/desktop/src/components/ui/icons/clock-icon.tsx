import { View } from "react-native";

interface ClockIconProps {
  size?: number;
  color?: string;
}

// View-based clock glyph — circle with two short hands. react-native-svg
// renders 0×0 on RN macOS, so we build it from primitives.
export function ClockIcon({ size = 14, color = "currentColor" }: ClockIconProps) {
  const stroke = 1.2;
  const pad = size * 0.1;
  const dim = size - pad * 2;
  const center = dim / 2;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: dim,
          height: dim,
          borderRadius: dim / 2,
          borderWidth: stroke,
          borderColor: color,
        }}
      >
        {/* Minute hand (vertical, from center to top) */}
        <View
          style={{
            position: "absolute",
            top: center * 0.45,
            left: center - stroke / 2,
            width: stroke,
            height: center * 0.55,
            backgroundColor: color,
            borderRadius: stroke / 2,
          }}
        />
        {/* Hour hand (horizontal, from center to right) */}
        <View
          style={{
            position: "absolute",
            top: center - stroke / 2,
            left: center,
            width: center * 0.5,
            height: stroke,
            backgroundColor: color,
            borderRadius: stroke / 2,
          }}
        />
      </View>
    </View>
  );
}
