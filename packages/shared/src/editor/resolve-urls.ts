import type { BlockNoteBlock, BlockNoteInlineContent } from "./types";
import type { TipTapDoc, TipTapNode, TipTapMark } from "./types";
import {
  isAttachmentUrl,
  extractFilePath,
  isSignedStorageUrl,
  extractFilePathFromSignedUrl,
  toAttachmentUrl,
  extractFilePathFromLocalSrc,
} from "./attachment-url";
import { withTimeout } from "../async/with-timeout";

/**
 * What a reference to an attachment is: the src of an image (shown inline, so
 * worth a local copy) or a link / file block (opened on demand).
 */
export type AttachmentRefKind = "image" | "link";

/**
 * Turns an attachment's storage path into the URL to show. `kind` says what
 * refers to it; a path used both ways is resolved once, as "image".
 */
export type UrlResolver = (filePath: string, kind: AttachmentRefKind) => Promise<string>;

/**
 * `resolver` with each call bounded by `ms`. A call that takes longer, or
 * rejects, resolves to the reference's own `attachment://` URL, so that one
 * reference is left unresolved while every other one in the note keeps what it
 * resolved to: a link whose signed URL hangs on a network with no internet
 * can't cost a cached image its local src.
 */
export function withResolveTimeout(resolver: UrlResolver, ms: number): UrlResolver {
  return (filePath, kind) => withTimeout(resolver(filePath, kind), ms, toAttachmentUrl(filePath));
}

interface AttachmentRef {
  url: string;
  kind: AttachmentRefKind;
}

/** Resolve each distinct attachment:// URL once, keeping the ones that resolved. */
async function resolveRefs(
  refs: AttachmentRef[],
  resolver: UrlResolver,
): Promise<Map<string, string>> {
  const kinds = new Map<string, AttachmentRefKind>();
  for (const ref of refs) {
    if (kinds.get(ref.url) !== "image") kinds.set(ref.url, ref.kind);
  }
  const settled = await Promise.allSettled(
    [...kinds].map(async ([url, kind]) => {
      const resolved = await resolver(extractFilePath(url), kind);
      return [url, resolved] as const;
    }),
  );
  return new Map(
    settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
  );
}

const BLOCKNOTE_ATTACHMENT_BLOCK_TYPES = new Set(["image", "file"]);

function collectBlockNoteInlineUrls(
  content: BlockNoteInlineContent[] | undefined,
): AttachmentRef[] {
  if (!content) return [];
  const urls: AttachmentRef[] = [];
  for (const item of content) {
    if (item.type === "link" && typeof item.href === "string" && isAttachmentUrl(item.href)) {
      urls.push({ url: item.href, kind: "link" });
    }
    if (item.type === "link" && item.content) {
      urls.push(...collectBlockNoteInlineUrls(item.content));
    }
  }
  return urls;
}

function collectBlockNoteImageUrls(blocks: BlockNoteBlock[]): AttachmentRef[] {
  const urls: AttachmentRef[] = [];
  for (const block of blocks) {
    if (BLOCKNOTE_ATTACHMENT_BLOCK_TYPES.has(block.type) && typeof block.props?.url === "string") {
      const url = block.props.url;
      if (isAttachmentUrl(url)) {
        urls.push({ url, kind: block.type === "image" ? "image" : "link" });
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
  const refs = collectBlockNoteImageUrls(blocks);
  if (refs.length === 0) return blocks;
  return applyResolvedUrls(blocks, await resolveRefs(refs, resolver));
}

const TIPTAP_ATTACHMENT_NODE_TYPES = new Set(["image", "file"]);

function collectTipTapImageUrls(nodes: TipTapNode[]): AttachmentRef[] {
  const urls: AttachmentRef[] = [];
  for (const node of nodes) {
    if (TIPTAP_ATTACHMENT_NODE_TYPES.has(node.type) && typeof node.attrs?.src === "string") {
      const src = node.attrs.src;
      if (isAttachmentUrl(src)) {
        urls.push({ url: src, kind: node.type === "image" ? "image" : "link" });
      }
    }
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (
          mark.type === "link" &&
          typeof mark.attrs?.href === "string" &&
          isAttachmentUrl(mark.attrs.href)
        ) {
          urls.push({ url: mark.attrs.href, kind: "link" });
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
  const refs = collectTipTapImageUrls(doc.content);
  if (refs.length === 0) return doc;
  return {
    ...doc,
    content: applyResolvedTipTapUrls(doc.content, await resolveRefs(refs, resolver)),
  };
}

// --- Save path: map display URLs back to attachment:// ---

/**
 * The `attachment://` form of a URL the editors only show, or null when `url`
 * is not one: a Supabase signed URL (older content, or a session's display
 * src) or a device-local cached-file src (ADR-0086). A local src must never
 * be stored: it names a file on one device, so it would show as a broken
 * image everywhere else.
 */
function canonicalAttachmentUrl(url: string): string | null {
  if (isSignedStorageUrl(url)) {
    const filePath = extractFilePathFromSignedUrl(url);
    return filePath ? toAttachmentUrl(filePath) : null;
  }
  const localPath = extractFilePathFromLocalSrc(url);
  return localPath ? toAttachmentUrl(localPath) : null;
}

function migrateBlockNoteInlineSignedUrls(
  content: BlockNoteInlineContent[] | undefined,
): BlockNoteInlineContent[] | undefined {
  if (!content) return content;
  return content.map((item) => {
    if (item.type !== "link") return item;
    const nextHref =
      typeof item.href === "string" ? (canonicalAttachmentUrl(item.href) ?? item.href) : item.href;
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
      typeof newBlock.props?.url === "string"
    ) {
      const canonical = canonicalAttachmentUrl(newBlock.props.url);
      if (canonical) {
        newBlock.props = { ...newBlock.props, url: canonical };
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

/**
 * Rewrites every display URL in `blocks` (signed storage URLs and device-local
 * cached-file srcs) to the canonical `attachment://<path>`. Every content write
 * goes through it: `serializeEditorContent`, the mobile attachment insert and
 * the web PATCH route.
 */
export function migrateSignedUrlsToAttachmentUrls(blocks: BlockNoteBlock[]): BlockNoteBlock[] {
  return migrateBlockNoteSignedUrls(blocks);
}
