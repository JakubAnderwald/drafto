import type { BlockNoteBlock, BlockNoteInlineContent } from "./types";
import type { TipTapDoc, TipTapNode, TipTapMark } from "./types";
import {
  isAttachmentUrl,
  extractFilePath,
  isSignedStorageUrl,
  extractFilePathFromSignedUrl,
  toAttachmentUrl,
} from "./attachment-url";

type UrlResolver = (filePath: string) => Promise<string>;

const BLOCKNOTE_ATTACHMENT_BLOCK_TYPES = new Set(["image", "file"]);

function collectBlockNoteInlineUrls(content: BlockNoteInlineContent[] | undefined): string[] {
  if (!content) return [];
  const urls: string[] = [];
  for (const item of content) {
    if (item.type === "link" && typeof item.href === "string" && isAttachmentUrl(item.href)) {
      urls.push(item.href);
    }
    if (item.type === "link" && item.content) {
      urls.push(...collectBlockNoteInlineUrls(item.content));
    }
  }
  return urls;
}

function collectBlockNoteImageUrls(blocks: BlockNoteBlock[]): string[] {
  const urls: string[] = [];
  for (const block of blocks) {
    if (BLOCKNOTE_ATTACHMENT_BLOCK_TYPES.has(block.type) && typeof block.props?.url === "string") {
      const url = block.props.url;
      if (isAttachmentUrl(url)) {
        urls.push(url);
      }
    }
    if (Array.isArray(block.content)) {
      urls.push(...collectBlockNoteInlineUrls(block.content));
    }
    if (block.children) {
      urls.push(...collectBlockNoteImageUrls(block.children));
    }
  }
  return urls;
}

function applyResolvedInlineUrls(
  content: BlockNoteInlineContent[] | undefined,
  urlMap: Map<string, string>,
): BlockNoteInlineContent[] | undefined {
  if (!content) return content;
  return content.map((item) => {
    if (item.type !== "link") return item;
    const nextHref =
      typeof item.href === "string" && urlMap.has(item.href) ? urlMap.get(item.href)! : item.href;
    return {
      ...item,
      href: nextHref,
      content: applyResolvedInlineUrls(item.content, urlMap),
    };
  });
}

function applyResolvedUrls(
  blocks: BlockNoteBlock[],
  urlMap: Map<string, string>,
): BlockNoteBlock[] {
  return blocks.map((block) => {
    const newBlock = { ...block };
    if (
      BLOCKNOTE_ATTACHMENT_BLOCK_TYPES.has(newBlock.type) &&
      typeof newBlock.props?.url === "string" &&
      urlMap.has(newBlock.props.url)
    ) {
      newBlock.props = { ...newBlock.props, url: urlMap.get(newBlock.props.url)! };
    }
    if (Array.isArray(newBlock.content)) {
      newBlock.content = applyResolvedInlineUrls(
        newBlock.content as BlockNoteInlineContent[],
        urlMap,
      );
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
  const settled = await Promise.allSettled(
    uniqueUrls.map(async (url) => {
      const filePath = extractFilePath(url);
      const signedUrl = await resolver(filePath);
      return [url, signedUrl] as const;
    }),
  );

  const urlMap = new Map(
    settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
  );
  return applyResolvedUrls(blocks, urlMap);
}

const TIPTAP_ATTACHMENT_NODE_TYPES = new Set(["image", "file"]);

function collectTipTapImageUrls(nodes: TipTapNode[]): string[] {
  const urls: string[] = [];
  for (const node of nodes) {
    if (TIPTAP_ATTACHMENT_NODE_TYPES.has(node.type) && typeof node.attrs?.src === "string") {
      const src = node.attrs.src;
      if (isAttachmentUrl(src)) {
        urls.push(src);
      }
    }
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (
          mark.type === "link" &&
          typeof mark.attrs?.href === "string" &&
          isAttachmentUrl(mark.attrs.href)
        ) {
          urls.push(mark.attrs.href);
        }
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
      TIPTAP_ATTACHMENT_NODE_TYPES.has(newNode.type) &&
      typeof newNode.attrs?.src === "string" &&
      urlMap.has(newNode.attrs.src)
    ) {
      newNode.attrs = { ...newNode.attrs, src: urlMap.get(newNode.attrs.src)! };
    }
    if (Array.isArray(newNode.marks)) {
      newNode.marks = newNode.marks.map<TipTapMark>((mark) => {
        if (
          mark.type === "link" &&
          typeof mark.attrs?.href === "string" &&
          urlMap.has(mark.attrs.href)
        ) {
          return { ...mark, attrs: { ...mark.attrs, href: urlMap.get(mark.attrs.href)! } };
        }
        return mark;
      });
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
  const settled = await Promise.allSettled(
    uniqueUrls.map(async (url) => {
      const filePath = extractFilePath(url);
      const signedUrl = await resolver(filePath);
      return [url, signedUrl] as const;
    }),
  );

  const urlMap = new Map(
    settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
  );
  return { ...doc, content: applyResolvedTipTapUrls(doc.content, urlMap) };
}

// --- Backward compatibility: migrate old signed URLs to attachment:// ---

function migrateBlockNoteInlineSignedUrls(
  content: BlockNoteInlineContent[] | undefined,
): BlockNoteInlineContent[] | undefined {
  if (!content) return content;
  return content.map((item) => {
    if (item.type !== "link") return item;
    const nextHref =
      typeof item.href === "string" && isSignedStorageUrl(item.href)
        ? (() => {
            const filePath = extractFilePathFromSignedUrl(item.href!);
            return filePath ? toAttachmentUrl(filePath) : item.href;
          })()
        : item.href;
    return {
      ...item,
      href: nextHref,
      content: migrateBlockNoteInlineSignedUrls(item.content),
    };
  });
}

function migrateBlockNoteSignedUrls(blocks: BlockNoteBlock[]): BlockNoteBlock[] {
  return blocks.map((block) => {
    const newBlock = { ...block };
    if (
      BLOCKNOTE_ATTACHMENT_BLOCK_TYPES.has(newBlock.type) &&
      typeof newBlock.props?.url === "string" &&
      isSignedStorageUrl(newBlock.props.url)
    ) {
      const filePath = extractFilePathFromSignedUrl(newBlock.props.url);
      if (filePath) {
        newBlock.props = { ...newBlock.props, url: toAttachmentUrl(filePath) };
      }
    }
    if (Array.isArray(newBlock.content)) {
      newBlock.content = migrateBlockNoteInlineSignedUrls(
        newBlock.content as BlockNoteInlineContent[],
      );
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
