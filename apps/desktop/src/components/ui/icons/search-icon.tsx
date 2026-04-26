import { View } from "react-native";

interface SearchIconProps {
  size?: number;
  color?: string;
}

// View-based magnifying glass to avoid the 0×0 react-native-svg rendering
// bug on RN macOS. Circle in the upper-left, stem extending bottom-right.
export function SearchIcon({ size = 18, color = "currentColor" }: SearchIconProps) {
  const stroke = Math.max(1.5, size / 11);
  const circleSize = size * 0.6;
  const stemLen = size * 0.32;
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          position: "absolute",
          top: size * 0.05,
          left: size * 0.05,
          width: circleSize,
          height: circleSize,
          borderRadius: circleSize / 2,
          borderWidth: stroke,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          // Anchor pivot at the bottom-right of the circle
          top: size * 0.05 + circleSize * 0.78,
          left: size * 0.05 + circleSize * 0.78,
          width: stemLen,
          height: stroke,
          backgroundColor: color,
          borderRadius: stroke / 2,
          transform: [{ rotate: "45deg" }],
          transformOrigin: "0% 50%",
        }}
      />
    </View>
  );
}
