import { useCallback, useRef } from "react";
import { isAttachmentUrl, extractFilePath } from "@drafto/shared";

export function useAttachmentUrlResolver() {
  const urlCache = useRef(new Map<string, string>());

  return useCallback(async (url: string): Promise<string> => {
    if (!isAttachmentUrl(url)) {
      return url;
    }

    const cached = urlCache.current.get(url);
    if (cached) {
      return cached;
    }

    const filePath = extractFilePath(url);
    const response = await fetch("/api/attachments/resolve-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath }),
    });

    if (!response.ok) {
      throw new Error("Failed to resolve attachment URL");
    }

    const data = await response.json();
    urlCache.current.set(url, data.signedUrl);
    return data.signedUrl;
  }, []);
}
