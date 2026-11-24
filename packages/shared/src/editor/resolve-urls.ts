import type { BlockNoteBlock, BlockNoteInlineContent } from "./types";
import type { TipTapDoc, TipTapNode, TipTapMark } from "./types";
import {
  isAttachmentUrl,
  extractFilePath,
  toAttachmentUrl,
  canonicalAttachmentUrl,
} from "./attachment-url";
import { withTimeout } from "../async/with-timeout";

/**
 * What a reference to an attachment is: the src of an image (shown inline, so
 * worth a local copy) or a link / file block (opened on demand).
 */
export type AttachmentRefKind = "image" | "link";

/**
 * Turns an attachment's storage path into the URL to show. `kind` says what
 * refers to it; a path used both ways is resolved once per kind, so a link to
 * an image keeps a URL the platform can open (never the image's local src).
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

/** What each attachment:// URL resolved to, per kind of reference. */
type ResolvedRefs = Record<AttachmentRefKind, Map<string, string>>;

/** Resolve each distinct attachment:// URL once per kind, keeping the ones that resolved. */
async function resolveRefs(refs: AttachmentRef[], resolver: UrlResolver): Promise<ResolvedRefs> {
  const wanted = new Map<string, AttachmentRef>();
  for (const ref of refs) wanted.set(`${ref.kind}:${ref.url}`, ref);
  const settled = await Promise.allSettled(
    [...wanted.values()].map(async ({ url, kind }) => {
      const resolved = await resolver(extractFilePath(url), kind);
      return { url, kind, resolved };
    }),
  );
  const result: ResolvedRefs = { image: new Map(), link: new Map() };
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      const { url, kind, resolved } = outcome.value;
      result[kind].set(url, resolved);
    }
  }
  return result;
}

/** The kind of reference an image / file block or node makes. */
function blockKind(type: string): AttachmentRefKind {
  return type === "image" ? "image" : "link";
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
        urls.push({ url, kind: blockKind(block.type) });
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
  links: Map<string, string>,
): BlockNoteInlineContent[] | undefined {
  if (!content) return content;
  return content.map((item) => {
    if (item.type !== "link") return item;
    const nextHref =
      typeof item.href === "string" && links.has(item.href) ? links.get(item.href)! : item.href;
    return {
      ...item,
      href: nextHref,
      content: applyResolvedInlineUrls(item.content, links),
    };
  });
}

function applyResolvedUrls(blocks: BlockNoteBlock[], resolved: ResolvedRefs): BlockNoteBlock[] {
  return blocks.map((block) => {
    const newBlock = { ...block };
    if (
      BLOCKNOTE_ATTACHMENT_BLOCK_TYPES.has(newBlock.type) &&
      typeof newBlock.props?.url === "string"
    ) {
      const urls = resolved[blockKind(newBlock.type)];
      if (urls.has(newBlock.props.url)) {
        newBlock.props = { ...newBlock.props, url: urls.get(newBlock.props.url)! };
      }
    }
    if (Array.isArray(newBlock.content)) {
      newBlock.content = applyResolvedInlineUrls(
        newBlock.content as BlockNoteInlineContent[],
        resolved.link,
      );
    }
    if (newBlock.children) {
      newBlock.children = applyResolvedUrls(newBlock.children, resolved);
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
        urls.push({ url: src, kind: blockKind(node.type) });
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

function applyResolvedTipTapUrls(nodes: TipTapNode[], resolved: ResolvedRefs): TipTapNode[] {
  return nodes.map((node) => {
    const newNode = { ...node };
    if (TIPTAP_ATTACHMENT_NODE_TYPES.has(newNode.type) && typeof newNode.attrs?.src === "string") {
      const urls = resolved[blockKind(newNode.type)];
      if (urls.has(newNode.attrs.src)) {
        newNode.attrs = { ...newNode.attrs, src: urls.get(newNode.attrs.src)! };
      }
    }
    if (Array.isArray(newNode.marks)) {
      const links = resolved.link;
      newNode.marks = newNode.marks.map<TipTapMark>((mark) => {
        if (
          mark.type === "link" &&
          typeof mark.attrs?.href === "string" &&
          links.has(mark.attrs.href)
        ) {
          return { ...mark, attrs: { ...mark.attrs, href: links.get(mark.attrs.href)! } };
        }
        return mark;
      });
    }
    if (newNode.content) {
      newNode.content = applyResolvedTipTapUrls(newNode.content, resolved);
    }
    return newNode;
  });
}

/**
 * Whether `doc` refers to any attachment that `resolveTipTapImageUrls` would
 * resolve: an image, or a file link. A note with only files needs resolving
 * too, so its links open and get the file card (PrimeTestLab 11035 S-04).
 */
export function hasTipTapAttachmentRefs(doc: TipTapDoc): boolean {
  return collectTipTapImageUrls(doc.content).length > 0;
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
