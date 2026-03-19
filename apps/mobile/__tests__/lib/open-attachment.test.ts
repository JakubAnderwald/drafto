import { Platform, Linking } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { openAttachment } from "@/lib/data/open-attachment";

jest.mock("expo-web-browser", () => ({
  openBrowserAsync: jest.fn(),
  WebBrowserPresentationStyle: { FULL_SCREEN: 0 },
  WebBrowserResultType: { DISMISS: "dismiss", CANCEL: "cancel", OPENED: "opened" },
}));

const mockOpenBrowserAsync = WebBrowser.openBrowserAsync as jest.MockedFunction<
  typeof WebBrowser.openBrowserAsync
>;

const mockCanOpenURL = jest.spyOn(Linking, "canOpenURL");
const mockOpenURL = jest.spyOn(Linking, "openURL");

beforeEach(() => {
  jest.clearAllMocks();
  mockCanOpenURL.mockResolvedValue(true);
  mockOpenURL.mockResolvedValue(true);
  mockOpenBrowserAsync.mockResolvedValue({
    type: WebBrowser.WebBrowserResultType.DISMISS,
  });
});

describe("openAttachment", () => {
  describe("uploaded attachments", () => {
    it("opens signed URL in in-app browser", async () => {
      const result = await openAttachment({
        signedUrl: "https://example.com/signed-url",
        localUri: null,
        isPending: false,
      });

      expect(mockOpenBrowserAsync).toHaveBeenCalledWith(
        "https://example.com/signed-url",
        expect.objectContaining({
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
        }),
      );
      expect(result).toEqual({ status: "opened" });
    });

    it("falls back to Linking.openURL when in-app browser fails", async () => {
      mockOpenBrowserAsync.mockRejectedValue(new Error("Browser unavailable"));

      const result = await openAttachment({
        signedUrl: "https://example.com/signed-url",
        localUri: null,
        isPending: false,
      });

      expect(mockOpenURL).toHaveBeenCalledWith("https://example.com/signed-url");
      expect(result).toEqual({ status: "opened" });
    });

    it("returns unavailable when both browser and linking fail", async () => {
      mockOpenBrowserAsync.mockRejectedValue(new Error("Browser fail"));
      mockOpenURL.mockRejectedValue(new Error("Linking fail"));

      const result = await openAttachment({
        signedUrl: "https://example.com/signed-url",
        localUri: null,
        isPending: false,
      });

      expect(result).toEqual({ status: "unavailable", reason: "Failed to open attachment" });
    });

    it("returns unavailable when signedUrl is null", async () => {
      const result = await openAttachment({
        signedUrl: null,
        localUri: null,
        isPending: false,
      });

      expect(result).toEqual({
        status: "unavailable",
        reason: "Could not load attachment URL",
      });
      expect(mockOpenBrowserAsync).not.toHaveBeenCalled();
    });
  });

  describe("pending attachments", () => {
    it("returns unavailable when localUri is null", async () => {
      const result = await openAttachment({
        signedUrl: null,
        localUri: null,
        isPending: true,
      });

      expect(result).toEqual({ status: "unavailable", reason: "File is still uploading" });
    });

    it("returns unavailable on Android (file:// URIs not supported)", async () => {
      const originalOS = Platform.OS;
      (Platform as { OS: string }).OS = "android";

      const result = await openAttachment({
        signedUrl: null,
        localUri: "file:///data/user/0/com.app/files/test.jpg",
        isPending: true,
      });

      expect(result).toEqual({
        status: "unavailable",
        reason: "File will be available after upload completes",
      });

      (Platform as { OS: string }).OS = originalOS;
    });

    it("opens local file on iOS via Linking", async () => {
      const originalOS = Platform.OS;
      (Platform as { OS: string }).OS = "ios";

      const result = await openAttachment({
        signedUrl: null,
        localUri: "file:///var/mobile/Containers/test.jpg",
        isPending: true,
      });

      expect(mockOpenURL).toHaveBeenCalledWith("file:///var/mobile/Containers/test.jpg");
      expect(result).toEqual({ status: "opened" });

      (Platform as { OS: string }).OS = originalOS;
    });

    it("returns unavailable when iOS cannot open the URI", async () => {
      const originalOS = Platform.OS;
      (Platform as { OS: string }).OS = "ios";
      mockCanOpenURL.mockResolvedValue(false);

      const result = await openAttachment({
        signedUrl: null,
        localUri: "file:///var/mobile/test.bin",
        isPending: true,
      });

      expect(result).toEqual({ status: "unavailable", reason: "Cannot open this file type" });

      (Platform as { OS: string }).OS = originalOS;
    });

    it("returns unavailable when iOS Linking.openURL throws", async () => {
      const originalOS = Platform.OS;
      (Platform as { OS: string }).OS = "ios";
      mockOpenURL.mockRejectedValue(new Error("Failed"));

      const result = await openAttachment({
        signedUrl: null,
        localUri: "file:///var/mobile/test.jpg",
        isPending: true,
      });

      expect(result).toEqual({ status: "unavailable", reason: "Failed to open file" });

      (Platform as { OS: string }).OS = originalOS;
    });
  });
});
