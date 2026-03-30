import "@/lib/url-polyfill";
import { LogBox, AppRegistry } from "react-native";
import { App } from "./src/App";

// WatermelonDB emits "Diagnostic error: [Sync] Server wants client to update
// record ... but it doesn't exist locally" as a console.error on first sync.
// This is informational — WM creates the record automatically. Suppress the
// LogBox display so it doesn't confuse users.
LogBox.ignoreLogs(["Diagnostic error"]);

AppRegistry.registerComponent("Drafto", () => App);
