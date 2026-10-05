import { View } from "react-native";

interface EllipsisIconProps {
  size?: number;
  color: string;
}

// View-based horizontal ellipsis (⋯) to avoid the 0×0 react-native-svg rendering bug on RN macOS.
export function EllipsisIcon({ size = 16, color }: EllipsisIconProps) {
  const dot = Math.max(2, size / 6);
  return (
    <View
      style={{
        width: size,
        height: size,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: size / 12,
      }}
    >
      {[0, 1, 2].map((index) => (
        <View
          key={index}
          style={{
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
}
