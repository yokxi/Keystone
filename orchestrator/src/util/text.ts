/**
 * Replacer di JSON.stringify per le trascrizioni: toglie i dati delle immagini (base64 dei blocchi
 * immagine, data URL). Le schermate restano in ~/.keystone, mai nelle trascrizioni.
 */
export function redactImageData(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.startsWith('data:image/')) return '[immagine omessa da Keystone]';
  if (key === 'data' && value.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(value.slice(0, 256))) return '[immagine omessa da Keystone]';
  return value;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Identificativo leggibile per nomi di file e branch: minuscole, [a-z0-9-], al massimo `max` caratteri. */
export function slugify(s: string, max = 40): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'x';
}

export function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function lastLines(s: string, n: number): string {
  return s.replace(/\r\n/g, '\n').split('\n').slice(-n).join('\n');
}
