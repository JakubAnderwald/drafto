import { Text, View, StyleSheet } from "react-native";

export default function NotebooksScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Notebooks</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    fontSize: 18,
    color: "#666",
  },
});
