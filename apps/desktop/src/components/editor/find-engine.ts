import type { WebViewMessageEvent } from "react-native-webview";

/** `type` field on messages the injected find engine posts back to the app. */
export const FIND_RESULT_TYPE = "draftoFindResult";

export interface FindResult {
  /** 1-based index of the active match, or 0 when there are no matches. */
  current: number;
  /** Total number of matches for the current query. */
  total: number;
}

/**
 * JavaScript injected into the tentap WebView to drive find-in-note.
 *
 * It defines `window.__draftoFind` exactly once (idempotent) and paints matches
 * with the CSS Custom Highlight API — which overlays highlight ranges WITHOUT
 * mutating the ProseMirror DOM. That's the whole point: find must never edit the
 * document, fire tentap's onChange, or risk corrupting note content. Match
 * counts are reported back via `ReactNativeWebView.postMessage` and parsed by
 * `parseFindResult`.
 *
 * `search(query, pattern)` receives a pre-escaped regex `pattern` (built on the
 * native side) and matches case-insensitively against the ORIGINAL text with the
 * 'i' flag, so match offsets are always valid indices into the text node.
 * (Matching against `toLowerCase()` would be unsafe: lowercasing can change
 * string length — e.g. 'İ' → 'i̇' — which pushes range offsets past the node
 * length and throws IndexSizeError.) Matches are found within a single text
 * node; a phrase split across formatting boundaries won't match — an accepted
 * v1 limit.
 */
export const FIND_ENGINE_SETUP = `(function(){
  if (window.__draftoFind) { return; }
  var ALL = 'drafto-find';
  var CUR = 'drafto-find-current';
  var STYLE_ID = 'drafto-find-style';
  var state = { ranges: [], index: 0 };

  function supported(){
    return !!(window.CSS && window.CSS.highlights && typeof window.Highlight !== 'undefined');
  }
  function ensureStyle(){
    if (document.getElementById(STYLE_ID)) { return; }
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
      '::highlight(drafto-find){background-color:rgba(250,204,21,0.40);}' +
      '::highlight(drafto-find-current){background-color:rgba(249,115,22,0.85);}';
    (document.head || document.documentElement).appendChild(s);
  }
  function root(){ return document.querySelector('.ProseMirror') || document.body; }
  function post(){
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'draftoFindResult',
        total: state.ranges.length,
        current: state.ranges.length ? state.index + 1 : 0
      }));
    } catch (e) {}
  }
  function clearHighlights(){
    if (supported()){
      window.CSS.highlights.delete(ALL);
      window.CSS.highlights.delete(CUR);
    }
  }
  function paint(){
    if (!supported()){ return; }
    var all = new window.Highlight();
    for (var i = 0; i < state.ranges.length; i++){ all.add(state.ranges[i]); }
    window.CSS.highlights.set(ALL, all);
    if (state.ranges.length){
      window.CSS.highlights.set(CUR, new window.Highlight(state.ranges[state.index]));
    } else {
      window.CSS.highlights.delete(CUR);
    }
  }
  function scrollToCurrent(){
    if (!state.ranges.length){ return; }
    var node = state.ranges[state.index].startContainer;
    var el = node.nodeType === 3 ? node.parentElement : node;
    if (el && el.scrollIntoView){ el.scrollIntoView({ block: 'center', inline: 'nearest' }); }
  }
  function search(query, pattern){
    ensureStyle();
    state.ranges = [];
    state.index = 0;
    if (query && pattern){
      var re;
      try { re = new RegExp(pattern, 'gi'); } catch (e) { re = null; }
      if (re){
        var walker = document.createTreeWalker(root(), NodeFilter.SHOW_TEXT, null);
        var node;
        while ((node = walker.nextNode())){
          var text = node.nodeValue || '';
          re.lastIndex = 0;
          var m;
          while ((m = re.exec(text)) !== null){
            var range = document.createRange();
            range.setStart(node, m.index);
            range.setEnd(node, m.index + m[0].length);
            state.ranges.push(range);
            if (m.index === re.lastIndex){ re.lastIndex++; }
          }
        }
      }
    }
    paint();
    scrollToCurrent();
    post();
  }
  function step(delta){
    if (!state.ranges.length){ post(); return; }
    state.index = (state.index + delta + state.ranges.length) % state.ranges.length;
    paint();
    scrollToCurrent();
    post();
  }
  window.__draftoFind = {
    search: search,
    next: function(){ step(1); },
    prev: function(){ step(-1); },
    clear: function(){ state.ranges = []; state.index = 0; clearHighlights(); post(); }
  };
})();`;

// Re-inject the (idempotent) engine ahead of every command so a WebView reload
// can't leave a command targeting an undefined `window.__draftoFind`. The
// trailing `true;` keeps react-native-webview from warning about a
// non-serialisable injection result.
function withEngine(call: string): string {
  return `${FIND_ENGINE_SETUP} try { ${call} } catch (e) {} true;`;
}

// Escape regex metacharacters so the query matches literally (case-insensitivity
// comes from the engine's 'i' flag). Built here, on the native side, so the
// injected engine carries no un-escaped user input into `new RegExp`.
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** JS that (re)runs a search for `query` and highlights all matches. */
export function findSearchJS(query: string): string {
  return withEngine(
    `window.__draftoFind.search(${JSON.stringify(query)}, ${JSON.stringify(escapeRegExp(query))});`,
  );
}

/** JS that advances to the next/previous match (wrapping). */
export function findStepJS(direction: "next" | "prev"): string {
  return withEngine(`window.__draftoFind.${direction}();`);
}

/** JS that clears all find highlights. */
export function findClearJS(): string {
  return withEngine(`window.__draftoFind.clear();`);
}

/**
 * Parse a raw WebView message into a {@link FindResult}, or `null` if it isn't a
 * find-result message (tentap emits many other message types through the same
 * channel). Never throws.
 */
export function parseFindResult(event: WebViewMessageEvent): FindResult | null {
  try {
    const data = JSON.parse(event.nativeEvent.data) as {
      type?: unknown;
      current?: unknown;
      total?: unknown;
    };
    if (!data || data.type !== FIND_RESULT_TYPE) {
      return null;
    }
    const total = typeof data.total === "number" ? data.total : 0;
    const current = typeof data.current === "number" ? data.current : 0;
    return { current, total };
  } catch {
    return null;
  }
}
