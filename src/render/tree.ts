import type { ParsedIsoBox } from '@svta/cml-iso-bmff';

const children = (box: ParsedIsoBox): ParsedIsoBox[] | undefined =>
  (box as { boxes?: ParsedIsoBox[] }).boxes;

function label(box: ParsedIsoBox, onSelect: (box: ParsedIsoBox) => void): HTMLElement {
  const span = document.createElement('span');
  span.className = 'box-label';
  span.append(`${box.type} `);
  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = `(${box.size} B)`;
  span.appendChild(size);
  span.addEventListener('click', (e) => {
    e.preventDefault(); // don't toggle <details> when selecting
    document.querySelectorAll('.box-label.selected').forEach((el) => el.classList.remove('selected'));
    span.classList.add('selected');
    onSelect(box);
  });
  return span;
}

function renderBox(box: ParsedIsoBox, onSelect: (box: ParsedIsoBox) => void): HTMLElement {
  const childBoxes = children(box);
  if (childBoxes?.length) {
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    summary.appendChild(label(box, onSelect));
    details.appendChild(summary);
    for (const child of childBoxes) details.appendChild(renderBox(child, onSelect));
    return details;
  }
  const leaf = document.createElement('div');
  leaf.className = 'leaf';
  leaf.appendChild(label(box, onSelect));
  return leaf;
}

export function renderTree(
  container: HTMLElement,
  boxes: ParsedIsoBox[],
  onSelect: (box: ParsedIsoBox) => void,
): void {
  container.replaceChildren(...boxes.map((b) => renderBox(b, onSelect)));
}
