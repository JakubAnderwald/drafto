/**
 * The longest search query `/api/notes/search` accepts, counted as a JavaScript string length
 * (UTF-16 code units), which is also what an `<input>`'s `maxLength` counts. The route answers 400
 * above it, so the search overlay caps its input at the same length: a longer query could only
 * fail, and would show (and report) as a failed search.
 */
export const MAX_SEARCH_QUERY_LENGTH = 200;
