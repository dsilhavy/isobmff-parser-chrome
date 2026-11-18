/** Syntax classes of the MPD source view. `text` is character data and whitespace. */
export type TokenKind = 'punct' | 'tag' | 'attr' | 'value' | 'comment' | 'meta' | 'text';
export type Token = [kind: TokenKind, text: string];

/**
 * Splits XML source into coloured tokens, one array per line (line breaks removed).
 * Tolerant by design: it colours whatever it gets, well-formed or not; an unterminated
 * comment, declaration or attribute value runs to the end of the text.
 */
export function highlightLines(text: string): Token[][] {
  const lines: Token[][] = [[]];
  const emit = (kind: TokenKind, value: string) => {
    const parts = value.split('\n');
    parts.forEach((part, k) => {
      if (k) lines.push([]);
      const s = part.endsWith('\r') ? part.slice(0, -1) : part;
      if (!s) return;
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last && last[0] === kind) last[1] += s;
      else line.push([kind, s]);
    });
  };
  const n = text.length;
  const until = (from: number, end: string): number => {
    const e = text.indexOf(end, from);
    return e < 0 ? n : e + end.length;
  };
  const NAME = /[^\s<>/=!?"']+/y;
  const WS = /\s+/y;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (i < n) {
    if (text[i] !== '<') {
      const lt = text.indexOf('<', i);
      const stop = lt < 0 ? n : lt;
      emit('text', text.slice(i, stop));
      i = stop;
      continue;
    }
    let end = -1;
    let kind: TokenKind = 'meta';
    if (text.startsWith('<!--', i)) {
      end = until(i + 4, '-->');
      kind = 'comment';
    } else if (text.startsWith('<![CDATA[', i)) end = until(i + 9, ']]>');
    else if (text.startsWith('<?', i)) end = until(i + 2, '?>');
    else if (text.startsWith('<!', i)) {
      let depth = 0;
      for (end = i + 2; end < n; end++) {
        const c = text[end];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      end = Math.min(end + 1, n);
    }
    if (end >= 0) {
      emit(kind, text.slice(i, end));
      i = end;
      continue;
    }

    // start or end tag
    const open = text[i + 1] === '/' ? '</' : '<';
    emit('punct', open);
    i += open.length;
    NAME.lastIndex = i;
    const name = NAME.exec(text);
    if (name) {
      emit('tag', name[0]);
      i = NAME.lastIndex;
    }
    while (i < n) {
      const c = text[i];
      if (c === '>') {
        emit('punct', '>');
        i++;
        break;
      }
      if (c === '<') break; // malformed tag: start over at the next one
      if (c === '/' && text[i + 1] === '>') {
        emit('punct', '/>');
        i += 2;
        break;
      }
      if (c === '"' || c === "'") {
        const e = until(i + 1, c);
        emit('value', text.slice(i, e));
        i = e;
        continue;
      }
      if (c === '=') {
        emit('punct', '=');
        i++;
        continue;
      }
      WS.lastIndex = i;
      if (WS.exec(text)) {
        emit('text', text.slice(i, WS.lastIndex));
        i = WS.lastIndex;
        continue;
      }
      NAME.lastIndex = i;
      if (NAME.exec(text)) {
        emit('attr', text.slice(i, NAME.lastIndex));
        i = NAME.lastIndex;
        continue;
      }
      emit('text', c);
      i++;
    }
  }
  return lines;
}
