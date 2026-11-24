/**
 * RPC endpoint redaction for operator-facing logs: credentials in the URL
 * userinfo, secret-named query parameters, and API-key-shaped path segments are
 * replaced before a watcher description or CLI result is printed. Non-http(s)
 * text is returned unchanged so ordinary URLs in output keep their shape.
 */

const REDACTED = 'redacted';
const SECRET_QUERY_PARAM = /^(api[_-]?key|apikey|key|token|access[_-]?token|auth|secret|password|signature|sig)$/i;
const KEY_SHAPED_SEGMENT = /^[A-Za-z0-9_-]{20,}$/;
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi;
const TRAILING_PUNCTUATION = /[),.;]+$/;

export function redactRpcUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return value;
  }
  let changed = false;
  if (url.username !== '' || url.password !== '') {
    url.username = REDACTED;
    url.password = REDACTED;
    changed = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_PARAM.test(key)) {
      url.searchParams.set(key, REDACTED);
      changed = true;
    }
  }
  const pathname = url.pathname
    .split('/')
    .map((segment) => (KEY_SHAPED_SEGMENT.test(segment) ? REDACTED : segment))
    .join('/');
  if (pathname !== url.pathname) {
    url.pathname = pathname;
    changed = true;
  }
  return changed ? url.toString() : value;
}

export function redactRpcUrlsInText(value: string): string {
  return value.replace(URL_IN_TEXT, (match) => {
    const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    const endpoint = trailing === '' ? match : match.slice(0, -trailing.length);
    return `${redactRpcUrl(endpoint)}${trailing}`;
  });
}
