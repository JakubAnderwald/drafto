import { View } from "react-native";

interface CalendarIconProps {
  size?: number;
  color: string;
}

// View-based calendar glyph (outer rounded rect + horizontal divider near the
// top) — react-native-svg renders 0×0 on RN macOS.
export function CalendarIcon({ size = 14, color }: CalendarIconProps) {
  const stroke = 1.2;
  const padX = size * 0.14;
  const padY = size * 0.18;
  const headerHeight = (size - padY * 2) * 0.32;
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
          width: size - padX * 2,
          height: size - padY * 2,
          borderWidth: stroke,
          borderColor: color,
          borderRadius: 2,
        }}
      >
        <View
          style={{
            height: headerHeight,
            borderBottomWidth: stroke,
            borderBottomColor: color,
          }}
        />
      </View>
    </View>
  );
}
