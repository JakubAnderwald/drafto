import "@/lib/url-polyfill";
import { LogBox, AppRegistry } from "react-native";
import { App } from "./src/App";

if (__DEV__) {
  // WatermelonDB emits a diagnostic console.error during sync when the server
  // sends an "update" for a record not yet local. WM handles this by creating
  // the record — it's informational, not an actual error. Suppress the LogBox
  // banner so it doesn't confuse developers.
  LogBox.ignoreLogs(["Diagnostic error: [Sync]"]);
}

AppRegistry.registerComponent("Drafto", () => App);
