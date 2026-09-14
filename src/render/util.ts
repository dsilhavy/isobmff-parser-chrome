export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

export const basename = (url: string) => url.split('/').pop()?.split('?')[0] || url;

const pad2 = (n: number) => String(n).padStart(2, '0');
export const clock = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/** Handler chip: letter + CSS class. */
export function chipOf(handler: string | undefined): [letter: string, cls: string] {
  if (handler === 'soun') return ['A', 'audio'];
  if (handler === 'vide') return ['V', 'video'];
  if (handler === 'text' || handler === 'subt' || handler === 'sbtl') return ['T', 'text'];
  return [handler?.[0]?.toUpperCase() ?? '?', 'other'];
}

export function chip(handler: string | undefined): HTMLElement {
  const [letter, cls] = chipOf(handler);
  return el('span', `chip ${cls}`, letter);
}
