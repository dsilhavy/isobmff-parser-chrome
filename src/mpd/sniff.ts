/** True if the text's root element is `MPD` (after an optional BOM, XML declaration, comments, PIs and DOCTYPE). */
export function isMpdText(text: string): boolean {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < text.length && text.charCodeAt(i) <= 32) i++;
    let end: number;
    if (text.startsWith('<?', i)) end = text.indexOf('?>', i);
    else if (text.startsWith('<!--', i)) end = text.indexOf('-->', i);
    else if (text.startsWith('<!', i)) end = text.indexOf('>', i);
    else break;
    if (end < 0) return false;
    i = end + (text[end] === '>' ? 1 : text[end] === '?' ? 2 : 3);
  }
  return /^<(?:[\w.-]+:)?MPD[\s>/]/.test(text.slice(i, i + 80));
}

// Resource types DevTools reports that never carry an MPD.
const SKIP_TYPES = new Set(['image', 'font', 'stylesheet', 'script', 'media', 'websocket', 'manifest', 'ping', 'preflight', 'csp-violation-report', 'eventsource']);

/**
 * Cheap pre-check on request metadata, so only plausible MPD responses are read and sniffed:
 * an XML or textual (or missing) content type, or `.mpd` in the URL path.
 */
export function isMpdCandidate(meta: { resourceType?: string; mimeType?: string; url?: string }): boolean {
  if (meta.resourceType && SKIP_TYPES.has(meta.resourceType)) return false;
  const mime = (meta.mimeType ?? '').trim().toLowerCase();
  if (!mime || mime.includes('xml') || mime.startsWith('text/')) return true;
  return /\.mpd(?:$|[?#/])/i.test(meta.url ?? '');
}
