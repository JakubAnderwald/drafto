import { View } from "react-native";

interface PlusIconProps {
  size?: number;
  color: string;
}

// View-based plus to avoid the 0×0 react-native-svg rendering bug on RN macOS.
export function PlusIcon({ size = 16, color }: PlusIconProps) {
  const stroke = Math.max(1.5, size / 10);
  const arm = size * 0.62;
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
          position: "absolute",
          width: arm,
          height: stroke,
          backgroundColor: color,
          borderRadius: stroke / 2,
        }}
      />
      <View
        style={{
          position: "absolute",
          width: stroke,
          height: arm,
          backgroundColor: color,
          borderRadius: stroke / 2,
        }}
      />
    </View>
  );
}
