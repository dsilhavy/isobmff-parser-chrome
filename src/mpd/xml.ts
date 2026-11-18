/**
 * Small XML parser for MPDs that keeps source positions, which `DOMParser` does not:
 * findings are anchored to MPD lines. It checks well-formedness as far as an MPD needs
 * (tag nesting, attribute syntax, a single root) and resolves namespace prefixes.
 * DTDs are skipped; only the predefined and numeric character entities are decoded.
 */

export interface XmlAttr {
  name: string;
  value: string;
  line: number; // 1-based
}

export interface XmlElement {
  name: string; // as written, with prefix
  local: string;
  prefix: string;
  ns?: string;
  attrs: XmlAttr[];
  children: XmlElement[];
  text: string; // concatenated character data directly inside this element
  line: number; // line of the start tag, 1-based
  endLine: number; // line of the end of the element
  start: number; // offset of '<' of the start tag
  end: number; // offset after the element
  parent?: XmlElement;
}

export interface XmlError {
  message: string;
  line: number;
}

export interface XmlDoc {
  root?: XmlElement;
  errors: XmlError[];
  lineCount: number;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (all, ref: string) => {
    if (ref[0] !== '#') return ENTITIES[ref] ?? all;
    const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

export function parseXml(text: string): XmlDoc {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const errors: XmlError[] = [];
  const fail = (message: string, offset: number) => void errors.push({ message, line: lineAt(offset) });
  const NAME = /[^\s<>/=!?"']+/y;
  const WS = /\s*/y;
  const skipWs = (at: number): number => {
    WS.lastIndex = at;
    WS.exec(text);
    return WS.lastIndex;
  };

  const n = text.length;
  let root: XmlElement | undefined;
  const stack: XmlElement[] = [];
  const scopes: Record<string, string>[] = [{ xml: 'http://www.w3.org/XML/1998/namespace' }];
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  parse: while (i < n) {
    const lt = text.indexOf('<', i);
    const stop = lt < 0 ? n : lt;
    if (stop > i) {
      const chunk = text.slice(i, stop);
      const top = stack.at(-1);
      if (top) top.text += decodeEntities(chunk);
      else if (chunk.trim()) {
        fail('text outside the root element', i + chunk.search(/\S/));
        break;
      }
      i = stop;
    }
    if (lt < 0) break;

    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4);
      if (e < 0) {
        fail('unterminated comment', i);
        break;
      }
      i = e + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i + 9);
      const top = stack.at(-1);
      if (e < 0 || !top) {
        fail(e < 0 ? 'unterminated CDATA section' : 'CDATA outside the root element', i);
        break;
      }
      top.text += text.slice(i + 9, e);
      i = e + 3;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const e = text.indexOf('?>', i + 2);
      if (e < 0) {
        fail('unterminated processing instruction', i);
        break;
      }
      i = e + 2;
      continue;
    }
    if (text.startsWith('<!', i)) {
      // DOCTYPE, possibly with an internal subset in [ ]
      let depth = 0;
      let j = i + 2;
      for (; j < n; j++) {
        const c = text[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (j >= n) {
        fail('unterminated declaration', i);
        break;
      }
      i = j + 1;
      continue;
    }

    if (text[i + 1] === '/') {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(text);
      const close = m ? skipWs(NAME.lastIndex) : -1;
      if (!m || text[close] !== '>') {
        fail('malformed end tag', i);
        break;
      }
      const top = stack.pop();
      scopes.pop();
      if (!top) {
        fail(`</${m[0]}> has no start tag`, i);
        break;
      }
      if (top.name !== m[0]) {
        stack.push(top);
        fail(`</${m[0]}> closes <${top.name}> opened on line ${top.line}`, i);
        break;
      }
      top.end = close + 1;
      top.endLine = lineAt(close);
      i = close + 1;
      continue;
    }

    // start tag
    NAME.lastIndex = i + 1;
    const m = NAME.exec(text);
    if (!m) {
      fail('malformed tag', i);
      break;
    }
    let j = NAME.lastIndex;
    const attrs: XmlAttr[] = [];
    let selfClose = false;
    let closed = false;
    for (;;) {
      j = skipWs(j);
      if (j >= n) break;
      if (text[j] === '>') {
        j++;
        closed = true;
        break;
      }
      if (text.startsWith('/>', j)) {
        j += 2;
        selfClose = closed = true;
        break;
      }
      NAME.lastIndex = j;
      const a = NAME.exec(text);
      if (!a) break;
      let k = skipWs(NAME.lastIndex);
      if (text[k] !== '=') break;
      k = skipWs(k + 1);
      const quote = text[k];
      if (quote !== '"' && quote !== "'") break;
      const e = text.indexOf(quote, k + 1);
      if (e < 0) break;
      if (attrs.some((x) => x.name === a[0])) fail(`duplicate attribute ${a[0]} on <${m[0]}>`, j);
      attrs.push({ name: a[0], value: decodeEntities(text.slice(k + 1, e)), line: lineAt(j) });
      j = e + 1;
    }
    if (!closed) {
      fail(`malformed start tag <${m[0]}>`, i);
      break;
    }

    const parent = stack.at(-1);
    if (!parent && root) {
      fail(`<${m[0]}> after the root element`, i);
      break parse;
    }
    const scope: Record<string, string> = Object.create(scopes.at(-1)!);
    for (const a of attrs) {
      if (a.name === 'xmlns') scope[''] = a.value;
      else if (a.name.startsWith('xmlns:')) scope[a.name.slice(6)] = a.value;
    }
    const colon = m[0].indexOf(':');
    const prefix = colon < 0 ? '' : m[0].slice(0, colon);
    const element: XmlElement = {
      name: m[0],
      local: colon < 0 ? m[0] : m[0].slice(colon + 1),
      prefix,
      ns: scope[prefix],
      attrs,
      children: [],
      text: '',
      line: lineAt(i),
      endLine: lineAt(j - 1),
      start: i,
      end: j,
      parent,
    };
    if (parent) parent.children.push(element);
    else root = element;
    if (!selfClose) {
      stack.push(element);
      scopes.push(scope);
    }
    i = j;
  }

  if (!errors.length && stack.length) {
    const open = stack.at(-1)!;
    errors.push({ message: `<${open.name}> is never closed`, line: open.line });
  }
  for (const open of stack) {
    open.end = n;
    open.endLine = lineStarts.length;
  }
  if (!root && !errors.length) errors.push({ message: 'no root element', line: 1 });
  return { root, errors, lineCount: lineStarts.length };
}

export const attr = (element: XmlElement, name: string): string | undefined => element.attrs.find((a) => a.name === name)?.value;

export const childrenOf = (element: XmlElement, local: string): XmlElement[] => element.children.filter((c) => c.local === local);
