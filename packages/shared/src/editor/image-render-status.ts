import { LOCAL_ATTACHMENT_FRAGMENT } from "../constants";

// Whether the note's images actually rendered in the native editors' WebView
// (ADR-0086). The WebView's own <img> nodes don't reliably reach the
// accessibility tree, so E2E tests and screen readers can't tell a loaded
// image from a broken one. A script injected into the editor reports each
// image's state, and the app mirrors it in small accessible views.

/** `type` of the message the injected script posts. */
export const IMAGE_RENDER_STATUS_MESSAGE_TYPE = "draftoImageStatus";

/** At most this many images are reported, so a long note can't flood the bridge. */
export const IMAGE_RENDER_STATUS_MAX_IMAGES = 20;

/** One image in the note, as the WebView last saw it. */
export interface ImageRenderState {
  /** The image's alt text, or its file name when it has none. */
  name: string;
  /** Loaded and decoded: `img.complete && img.naturalWidth > 0`. */
  rendered: boolean;
  /** Its height on screen, in CSS pixels (density-independent pixels). */
  height: number;
  /** Shown from the device's attachment cache (a `file:` src). */
  local: boolean;
}

/**
 * JavaScript to inject into the editor WebView. Installs the reporter once per
 * page (an image load or error, a DOM change, including an image's src or
 * alt, or a resize schedules a report)
 * and asks for a fresh report each time it is injected. A report is posted
 * only when it differs from the previous one. It reads the DOM and never
 * changes it, so it can't fire the editor's onChange.
 */
export const IMAGE_RENDER_STATUS_SCRIPT = `(function(){
  var w = window;
  if (!w.__draftoImageStatus) {
    var last = '';
    var timer = null;
    var MARKER = ${JSON.stringify(LOCAL_ATTACHMENT_FRAGMENT)};
    var nameOf = function(img){
      var alt = (img.getAttribute('alt') || '').trim();
      if (alt) { return alt; }
      var src = img.getAttribute('src') || '';
      var at = src.indexOf(MARKER);
      var path = src.split('#')[0].split('?')[0];
      if (at !== -1) {
        try { path = decodeURIComponent(src.slice(at + MARKER.length)); } catch (e) {}
      }
      var parts = path.split('/');
      return parts[parts.length - 1] || 'image';
    };
    var report = function(){
      timer = null;
      var root = document.querySelector('.ProseMirror') || document.body;
      var imgs = Array.prototype.slice.call(root.querySelectorAll('img'), 0, ${IMAGE_RENDER_STATUS_MAX_IMAGES});
      var images = imgs.map(function(img){
        return {
          name: nameOf(img),
          rendered: !!(img.complete && img.naturalWidth > 0),
          height: Math.round(img.getBoundingClientRect().height),
          local: (img.getAttribute('src') || '').indexOf('file:') === 0
        };
      });
      var json = JSON.stringify({ type: ${JSON.stringify(IMAGE_RENDER_STATUS_MESSAGE_TYPE)}, images: images });
      if (json === last) { return; }
      last = json;
      try { w.ReactNativeWebView.postMessage(json); } catch (e) {}
    };
    var schedule = function(){
      if (timer) { return; }
      timer = setTimeout(report, 150);
    };
    var onImageEvent = function(event){
      if (event.target && event.target.tagName === 'IMG') { schedule(); }
    };
    document.addEventListener('load', onImageEvent, true);
    document.addEventListener('error', onImageEvent, true);
    if (w.MutationObserver) {
      new MutationObserver(schedule).observe(document.body, {
        subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'alt', 'style', 'width', 'height']
      });
    }
    w.addEventListener('resize', schedule);
    w.__draftoImageStatus = { schedule: schedule, reset: function(){ last = ''; } };
  }
  w.__draftoImageStatus.reset();
  w.__draftoImageStatus.schedule();
})();
true;`;

function toImageRenderState(value: unknown): ImageRenderState | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, rendered, height, local } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof rendered !== "boolean") return null;
  return {
    name,
    rendered,
    height: typeof height === "number" && Number.isFinite(height) ? Math.max(0, height) : 0,
    local: local === true,
  };
}

/**
 * The images a WebView message reports, or null when the message is not an
 * image-status report (the editor's own messages, the find engine's results).
 */
export function parseImageRenderStatus(data: string): ImageRenderState[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { type, images } = parsed as { type?: unknown; images?: unknown };
  if (type !== IMAGE_RENDER_STATUS_MESSAGE_TYPE || !Array.isArray(images)) return null;
  return images
    .slice(0, IMAGE_RENDER_STATUS_MAX_IMAGES)
    .map(toImageRenderState)
    .filter((image): image is ImageRenderState => image !== null);
}

/**
 * The accessibility label for an image's status view. It ends with the image's
 * name, so the label of a photo ends in its extension (`photo.jpg`), which is
 * what the PrimeTestLab 10668 E2E check looks for.
 */
export function imageRenderStatusLabel(image: ImageRenderState): string {
  return image.rendered ? `Image shown: ${image.name}` : `Image not loaded: ${image.name}`;
}
