export type { Database, Json } from "./types/database";
export type {
  ProfileRow,
  NotebookRow,
  NoteRow,
  AttachmentRow,
  NotebookInsert,
  NoteInsert,
  AttachmentInsert,
  ApiKeyRow,
  NotebookUpdate,
  NoteUpdate,
} from "./types/api";
export {
  MAX_TITLE_LENGTH,
  MAX_NOTEBOOK_NAME_LENGTH,
  MAX_FILE_SIZE,
  MAX_FILE_SIZE_MB,
  FILE_TOO_LARGE_MESSAGE,
  FILE_EMPTY_MESSAGE,
  MAX_FILE_NAME_LENGTH,
  DEFAULT_STORAGE_QUOTA_BYTES,
  STORAGE_QUOTA_EXCEEDED_CODE,
  STORAGE_QUOTA_EXCEEDED_MESSAGE,
  DEFAULT_CONTENT_QUOTA_BYTES,
  CONTENT_QUOTA_EXCEEDED_CODE,
  CONTENT_QUOTA_EXCEEDED_MESSAGE,
  STORAGE_WARNING_RATIO,
  DEBOUNCE_MS,
  BUCKET_NAME,
  SIGNED_URL_EXPIRY_SECONDS,
  ATTACHMENT_URL_PREFIX,
  ACCOUNT_DELETE_CONFIRMATION,
  ACCOUNT_DELETED_MESSAGE,
  SIGNUP_EMAIL_REDIRECT_URL,
  SIGNUP_CONFIRMATION_SENT,
  SUPPORT_EMAIL,
  ACCOUNT_INACTIVE_TITLE,
  ACCOUNT_INACTIVE_MESSAGE,
  ACCOUNT_STILL_INACTIVE,
  ACCOUNT_STATUS_CHECK_FAILED,
  ACCOUNT_STATUS_CHECK_LABEL,
  EMAIL_CONFIRMED,
  DRAFTO_CLIENT_TAGS,
  ACTIVITY_QUEUE_MAX_DAYS,
  RECORD_ACTIVITY_MAX_DAYS,
  PASSWORD_VISIBILITY_LABELS,
  SIGN_OUT_CONFIRM_TITLE,
  SIGN_OUT_SYNCED_MESSAGE,
  SIGN_OUT_UNKNOWN_MESSAGE,
  SIGN_OUT_CONFIRM_LABEL,
  SIGN_OUT_ANYWAY_LABEL,
} from "./constants";
export type { DraftoClientTag } from "./constants";
export {
  utcDay,
  isUtcDay,
  normalizeActivityQueue,
  addDay,
  withoutSent,
  isDraftoClientTag,
} from "./activity/activity-days";
export { recordActivity } from "./activity/record-activity";
export type {
  ActivityRpcClient,
  ActivityRpcResponse,
  RecordActivityOutcome,
} from "./activity/record-activity";
export {
  ACCOUNT_DELETION_PATH,
  APPLE_NATIVE_CLIENT_ID,
  requestAccountDeletion,
  describeAccountDeletionFailure,
} from "./account/request-account-deletion";
export type {
  AccountDeletionRequestBody,
  AccountDeletionResult,
  AppleRevocationGrant,
  RequestAccountDeletionOptions,
} from "./account/request-account-deletion";
export {
  APPLE_SERVICES_ID,
  APPLE_REVOCATION_ORIGIN,
  APPLE_REVOCATION_REDIRECT_URI,
  APPLE_AUTHORIZE_URL,
  APPLE_REVOCATION_DEEP_LINK_PATH,
  APPLE_REVOCATION_RETURN_URLS,
  isAppleAuthorizationCode,
  isAppleErrorCode,
  isAppleRevocationNonce,
  buildAppleRevocationState,
  parseAppleRevocationState,
  buildAppleRevocationAuthorizeUrl,
  buildAppleRevocationDeepLink,
  isAppleRevocationDeepLink,
  readAppleRevocationCallback,
  hasAppleIdentity,
  appleDeletionNotice,
} from "./account/apple-revocation";
export type {
  AppleRevocationPlatform,
  AppleRevocationRelayFields,
  AppleRevocationCallback,
  AppleLinkableUser,
  AppleConfirmationKind,
} from "./account/apple-revocation";
export { formatRelativeTime } from "./formatters";
export {
  blocknoteToTiptap,
  tiptapToBlocknote,
  contentToTiptap,
  contentToBlocknote,
  toEditorDoc,
} from "./editor/format-converter";
export { extractTextFromContent } from "./editor/extract-text";
export { normalizeBlocks } from "./editor/normalize-blocks";
export { blockNoteToMarkdown, markdownToBlockNote } from "./editor/markdown-converter";
export { blocksToEnml, escapeXml, escapeAttr } from "./editor/blocknote-to-enml";
export type { EnmlMediaEntry, MediaIndex } from "./editor/blocknote-to-enml";
export { buildEnex, formatEvernoteDate } from "./editor/enex-builder";
export type { ExportedNote, ExportedResource, BuildEnexInput } from "./editor/enex-builder";
export {
  toAttachmentUrl,
  isAttachmentUrl,
  extractFilePath,
  isSignedStorageUrl,
  extractFilePathFromSignedUrl,
} from "./editor/attachment-url";
export {
  resolveBlockNoteImageUrls,
  resolveTipTapImageUrls,
  migrateSignedUrlsToAttachmentUrls,
} from "./editor/resolve-urls";
export {
  MAX_CONTENT_BASELINES,
  serializeEditorContent,
  serializeLoadedDoc,
  sameStoredContent,
  isNoOpContentSave,
  rememberContentBaseline,
  queueNoteWrite,
} from "./editor/content-save-guard";
export type { ContentBaseline } from "./editor/content-save-guard";
export { isVisibleRemoteChange } from "./sync/remote-change";
export type { SyncRawRecord } from "./sync/remote-change";
export { hasLocalEdit } from "./sync/local-edit";
export type { LocalChangeEntry } from "./sync/local-edit";
export { withTimeout } from "./async/with-timeout";
export type {
  BlockNoteBlock,
  BlockNoteInlineContent,
  BlockNoteTableContent,
  TipTapDoc,
  TipTapNode,
  TipTapMark,
} from "./editor/types";
export {
  toStorageSafeFileName,
  isStorageSafeFileName,
  truncateFileName,
  safeAttachmentFileName,
  buildAttachmentStoragePath,
  localAttachmentFileName,
} from "./storage/storage-key";
export {
  BYTES_PER_MEGABYTE,
  StorageQuotaError,
  bytesToMegabytes,
  megabytesToBytes,
  formatMegabytes,
  formatStorageUsage,
  storageFullMessage,
  isStorageQuotaError,
  storageQuotaErrorFromResponse,
  wouldExceedQuota,
  storageUsageRatio,
  storageUsageTone,
  storageUsageFromRow,
} from "./storage/storage-quota";
export type { StorageUsage, StorageUsageRow, StorageUsageTone } from "./storage/storage-quota";
export {
  ContentQuotaError,
  formatContentUsage,
  contentFullMessage,
  isContentQuotaError,
  contentUsageFromError,
  contentQuotaErrorFromResponse,
} from "./storage/content-quota";
export {
  colors,
  semanticLight,
  semanticDark,
  getSemanticColors,
  spacing,
  radii,
  fontFamily,
  fontSizes,
} from "./design-tokens";
export type { SemanticColors } from "./design-tokens";
export { describeSignOut, describeUnsyncedLoss } from "./account/sign-out-copy";
export type { SignOutCopy } from "./account/sign-out-copy";

// Offline attachment cache (ADR-0086)
export {
  ATTACHMENT_CACHE_DIR_NAME,
  LOCAL_ATTACHMENT_FRAGMENT,
  ATTACHMENT_PREFETCH_MAX_FILES,
  ATTACHMENT_PREFETCH_MAX_BYTES,
  ATTACHMENT_PREFETCH_MAX_FILE_BYTES,
} from "./constants";
export {
  toLocalAttachmentSrc,
  isLocalAttachmentSrc,
  extractFilePathFromLocalSrc,
  attachmentCacheRelativePath,
} from "./editor/attachment-url";
export { withResolveTimeout } from "./editor/resolve-urls";
export type { AttachmentRefKind, UrlResolver } from "./editor/resolve-urls";
export {
  IMAGE_RENDER_STATUS_MESSAGE_TYPE,
  IMAGE_RENDER_STATUS_MAX_IMAGES,
  IMAGE_RENDER_STATUS_SCRIPT,
  parseImageRenderStatus,
  imageRenderStatusLabel,
} from "./editor/image-render-status";
export type { ImageRenderState } from "./editor/image-render-status";
export {
  isCacheableAttachment,
  planAttachmentCacheEviction,
  selectPrefetchCandidates,
} from "./storage/attachment-cache-policy";
export {
  ATTACHMENT_CACHE_INDEX_FILE_NAME,
  AttachmentCacheIndex,
  parseAttachmentCacheIndex,
} from "./storage/attachment-cache-index";
export type { AttachmentCacheFile } from "./storage/attachment-cache-index";
export { EDITOR_PAGE_DIR_NAME, editorPageFileName, editorPageLocation } from "./editor/editor-page";
export type { EditorPageLocation } from "./editor/editor-page";
export {
  PREFETCH_MIN_INTERVAL_MS,
  createAttachmentPrefetcher,
} from "./storage/attachment-prefetch";
export type {
  AttachmentPrefetchDeps,
  AttachmentPrefetcher,
  PrefetchCacheState,
  PrefetchOptions,
  PrefetchResult,
} from "./storage/attachment-prefetch";
export type {
  AttachmentCacheEntry,
  PrefetchCandidate,
  PrefetchLimits,
} from "./storage/attachment-cache-policy";

export {
  RECONNECTED_HOLD_MS,
  initialOfflineBannerVariant,
  nextOfflineBannerVariant,
} from "./network/offline-banner";
export type { OfflineBannerEvent, OfflineBannerVariant } from "./network/offline-banner";

// Auth form validation and error copy (PrimeTestLab 11035 M-02, M-03)
export {
  EMAIL_REQUIRED_MESSAGE,
  INVALID_EMAIL_MESSAGE,
  isValidEmail,
  validateEmailField,
} from "./auth/email";
export {
  MIN_PASSWORD_LENGTH,
  PASSWORD_REQUIRED_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  validateCredentials,
  hasFieldErrors,
} from "./auth/credentials";
export type { AuthField, AuthFieldErrors, Credentials, CredentialsMode } from "./auth/credentials";
export {
  INVALID_CREDENTIALS_MESSAGE,
  USER_ALREADY_EXISTS_MESSAGE,
  EMAIL_NOT_CONFIRMED_MESSAGE,
  AUTH_RATE_LIMITED_MESSAGE,
  WEAK_PASSWORD_MESSAGE,
  AUTH_GENERIC_ERROR_MESSAGE,
  describeAuthError,
} from "./auth/auth-error-copy";
export type { AuthErrorLike, AuthErrorCopy } from "./auth/auth-error-copy";
export { oauthQueryParams } from "./auth/oauth-query-params";

// Notebook names and note counts (PrimeTestLab 11035 M-01, S-03; ADR-0097)
export {
  normalizeNotebookName,
  findDuplicateNotebook,
  duplicateNotebookNameMessage,
  formatNoteCount,
} from "./notebooks/notebook-name";
export type { NamedNotebook } from "./notebooks/notebook-name";

// Public drafto.eu pages linked from Settings → About (PrimeTestLab 11035 S-01)
export {
  DRAFTO_WEB_ORIGIN,
  PRIVACY_POLICY_PATH,
  PRIVACY_POLICY_URL,
  SUPPORT_PATH,
  SUPPORT_URL,
} from "./constants";

// --- PrimeTestLab 11035 S-04: file attachment card + size in the editors ---
export { formatFileSize } from "./formatters/file-size";
export { canonicalAttachmentUrl } from "./editor/attachment-url";
export { hasTipTapAttachmentRefs } from "./editor/resolve-urls";
export {
  ATTACHMENT_SIZES_CSS_TAG,
  ATTACHMENT_LINK_SELECTORS,
  attachmentHrefFragments,
  buildAttachmentCardCss,
  buildAttachmentSizeCss,
  buildFileBlockSizeCss,
  cssString,
} from "./editor/attachment-link-css";
export type { AttachmentSizeInfo } from "./editor/attachment-link-css";
