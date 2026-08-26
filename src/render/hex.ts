const CHUNK = 4096; // render this many bytes at a time; mdat can be megabytes
const ROW = 16;

function hexRows(bytes: Uint8Array, baseOffset: number, from: number, to: number): string {
  let out = '';
  for (let row = from; row < to; row += ROW) {
    const slice = bytes.subarray(row, Math.min(row + ROW, to));
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    out += `${(baseOffset + row).toString(16).padStart(8, '0')}  ${hex.padEnd(ROW * 3 - 1)}  ${ascii}\n`;
  }
  return out;
}

/** Hex dump of one box: `bytes` is the segment buffer, box spans [offset, offset+size). */
export function renderHex(container: HTMLElement, bytes: Uint8Array, offset: number, size: number): void {
  container.replaceChildren();
  const box = bytes.subarray(offset, offset + size);

  const h = document.createElement('h3');
  h.textContent = 'Hex';
  container.appendChild(h);

  const pre = document.createElement('pre');
  let rendered = Math.min(CHUNK, box.byteLength);
  pre.textContent = hexRows(box, offset, 0, rendered);
  container.appendChild(pre);

  if (rendered < box.byteLength) {
    const more = document.createElement('button');
    const update = () => {
      more.textContent = `Show more (${(box.byteLength - rendered).toLocaleString()} bytes remaining)`;
    };
    update();
    more.addEventListener('click', () => {
      const next = Math.min(rendered + CHUNK, box.byteLength);
      pre.textContent += hexRows(box, offset, rendered, next);
      rendered = next;
      if (rendered >= box.byteLength) more.remove();
      else update();
    });
    container.appendChild(more);
  }
}
