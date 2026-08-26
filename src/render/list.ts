import type { Segment } from '../capture';

function kind(segment: Segment): string {
  const types = new Set(segment.boxes.map((b) => b.type));
  if (types.has('moov')) return 'init';
  if (types.has('moof')) return 'media';
  return segment.boxes[0]?.type ?? 'error';
}

export function renderList(
  container: HTMLElement,
  segments: Segment[],
  selected: Segment | null,
  onSelect: (segment: Segment) => void,
): void {
  container.replaceChildren(
    ...segments.map((segment) => {
      const li = document.createElement('li');
      if (segment === selected) li.classList.add('selected');

      const badge = document.createElement('span');
      const k = kind(segment);
      badge.className = `badge ${k}`;
      badge.textContent = k;
      li.appendChild(badge);

      li.append(segment.url.split('/').pop()?.split('?')[0] || segment.url);

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${segment.time.toLocaleTimeString()} · ${segment.bytes.byteLength.toLocaleString()} B` +
        (segment.error ? ` · parse error: ${segment.error}` : '');
      meta.title = segment.url;
      li.appendChild(meta);

      li.title = segment.url;
      li.addEventListener('click', () => onSelect(segment));
      return li;
    }),
  );
}
