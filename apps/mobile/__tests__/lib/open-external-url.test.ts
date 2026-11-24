import { Linking } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { openExternalUrl } from "@/lib/open-external-url";

jest.mock("expo-web-browser", () => ({
  openBrowserAsync: jest.fn(),
  WebBrowserPresentationStyle: { FULL_SCREEN: 0 },
  WebBrowserResultType: { DISMISS: "dismiss" },
}));

const mockOpenBrowserAsync = WebBrowser.openBrowserAsync as jest.MockedFunction<
  typeof WebBrowser.openBrowserAsync
>;
const mockOpenURL = jest.spyOn(Linking, "openURL");

const URL = "https://drafto.eu/privacy";

describe("openExternalUrl (PrimeTestLab 11035 S-01)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenBrowserAsync.mockResolvedValue({ type: WebBrowser.WebBrowserResultType.DISMISS });
    mockOpenURL.mockResolvedValue(true);
  });

  it("opens the page in the in-app browser", async () => {
    await expect(openExternalUrl(URL)).resolves.toBe(true);

    expect(mockOpenBrowserAsync).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
      }),
    );
    expect(mockOpenURL).not.toHaveBeenCalled();
  });

  it("falls back to the system browser when the in-app one fails", async () => {
    mockOpenBrowserAsync.mockRejectedValue(new Error("no browser"));

    await expect(openExternalUrl(URL)).resolves.toBe(true);

    expect(mockOpenURL).toHaveBeenCalledWith(URL);
  });

  it("reports false when neither browser can open the page", async () => {
    mockOpenBrowserAsync.mockRejectedValue(new Error("no browser"));
    mockOpenURL.mockRejectedValue(new Error("no handler"));

    await expect(openExternalUrl(URL)).resolves.toBe(false);
  });
});
