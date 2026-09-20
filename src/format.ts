/** Human-readable scalar/array formatting shared by the fields pane and the init diff. */
export function formatValue(value: unknown): string {
  if (value instanceof Uint8Array) {
    const head = [...value.subarray(0, 32)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return `${value.byteLength} bytes${value.byteLength ? `: ${head}${value.byteLength > 32 ? ' …' : ''}` : ''}`;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  return String(value);
}
