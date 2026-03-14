import type { BlockNoteBlock } from "./types";
import type { TipTapDoc, TipTapNode } from "./types";
import {
  isAttachmentUrl,
  extractFilePath,
  isSignedStorageUrl,
  extractFilePathFromSignedUrl,
  toAttachmentUrl,
} from "./attachment-url";

type UrlResolver = (filePath: string) => Promise<string>;

function collectBlockNoteImageUrls(blocks: BlockNoteBlock[]): string[] {
  const urls: string[] = [];
  for (const block of blocks) {
    if (block.type === "image" && typeof block.props?.url === "string") {
      const url = block.props.url;
      if (isAttachmentUrl(url)) {
        urls.push(url);
      }
    }
    if (block.children) {
      urls.push(...collectBlockNoteImageUrls(block.children));
    }
  }
  return urls;
}

function applyResolvedUrls(
  blocks: BlockNoteBlock[],
  urlMap: Map<string, string>,
): BlockNoteBlock[] {
  return blocks.map((block) => {
    const newBlock = { ...block };
    if (
      newBlock.type === "image" &&
      typeof newBlock.props?.url === "string" &&
      urlMap.has(newBlock.props.url)
    ) {
      newBlock.props = { ...newBlock.props, url: urlMap.get(newBlock.props.url)! };
    }
    if (newBlock.children) {
      newBlock.children = applyResolvedUrls(newBlock.children, urlMap);
    }
    return newBlock;
  });
}

export async function resolveBlockNoteImageUrls(
  blocks: BlockNoteBlock[],
  resolver: UrlResolver,
): Promise<BlockNoteBlock[]> {
  const attachmentUrls = collectBlockNoteImageUrls(blocks);
  if (attachmentUrls.length === 0) return blocks;

  const uniqueUrls = [...new Set(attachmentUrls)];
  const resolved = await Promise.all(
    uniqueUrls.map(async (url) => {
      const filePath = extractFilePath(url);
      const signedUrl = await resolver(filePath);
      return [url, signedUrl] as const;
    }),
  );

  const urlMap = new Map(resolved);
  return applyResolvedUrls(blocks, urlMap);
}

function collectTipTapImageUrls(nodes: TipTapNode[]): string[] {
  const urls: string[] = [];
  for (const node of nodes) {
    if (node.type === "image" && typeof node.attrs?.src === "string") {
      const src = node.attrs.src;
      if (isAttachmentUrl(src)) {
        urls.push(src);
      }
    }
    if (node.content) {
      urls.push(...collectTipTapImageUrls(node.content));
    }
  }
  return urls;
}

function applyResolvedTipTapUrls(nodes: TipTapNode[], urlMap: Map<string, string>): TipTapNode[] {
  return nodes.map((node) => {
    const newNode = { ...node };
    if (
      newNode.type === "image" &&
      typeof newNode.attrs?.src === "string" &&
      urlMap.has(newNode.attrs.src)
    ) {
      newNode.attrs = { ...newNode.attrs, src: urlMap.get(newNode.attrs.src)! };
    }
    if (newNode.content) {
      newNode.content = applyResolvedTipTapUrls(newNode.content, urlMap);
    }
    return newNode;
  });
}

export async function resolveTipTapImageUrls(
  doc: TipTapDoc,
  resolver: UrlResolver,
): Promise<TipTapDoc> {
  const attachmentUrls = collectTipTapImageUrls(doc.content);
  if (attachmentUrls.length === 0) return doc;

  const uniqueUrls = [...new Set(attachmentUrls)];
  const resolved = await Promise.all(
    uniqueUrls.map(async (url) => {
      const filePath = extractFilePath(url);
      const signedUrl = await resolver(filePath);
      return [url, signedUrl] as const;
    }),
  );

  const urlMap = new Map(resolved);
  return { ...doc, content: applyResolvedTipTapUrls(doc.content, urlMap) };
}

// --- Backward compatibility: migrate old signed URLs to attachment:// ---

function migrateBlockNoteSignedUrls(blocks: BlockNoteBlock[]): BlockNoteBlock[] {
  return blocks.map((block) => {
    const newBlock = { ...block };
    if (
      newBlock.type === "image" &&
      typeof newBlock.props?.url === "string" &&
      isSignedStorageUrl(newBlock.props.url)
    ) {
      const filePath = extractFilePathFromSignedUrl(newBlock.props.url);
      if (filePath) {
        newBlock.props = { ...newBlock.props, url: toAttachmentUrl(filePath) };
      }
    }
    if (newBlock.children) {
      newBlock.children = migrateBlockNoteSignedUrls(newBlock.children);
    }
    return newBlock;
  });
}

export function migrateSignedUrlsToAttachmentUrls(blocks: BlockNoteBlock[]): BlockNoteBlock[] {
  return migrateBlockNoteSignedUrls(blocks);
}
