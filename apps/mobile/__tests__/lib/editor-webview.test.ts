import { editorWebViewBaseUrl } from "@/lib/editor-webview";

const mockDocument = { uri: "file:///data/user/0/eu.drafto.mobile/files" };
jest.mock("expo-file-system", () => ({
  Paths: {
    get document() {
      return mockDocument;
    },
  },
}));

describe("editorWebViewBaseUrl", () => {
  it("is the Documents directory as a file:// URL with a trailing slash", () => {
    expect(editorWebViewBaseUrl()).toBe("file:///data/user/0/eu.drafto.mobile/files/");
    mockDocument.uri = "file:///var/mobile/Documents/";
    expect(editorWebViewBaseUrl()).toBe("file:///var/mobile/Documents/");
  });
});
