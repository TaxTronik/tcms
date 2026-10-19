/** Baut eine URL aus Pfad, bestehenden Query-Parametern und Änderungen (null entfernt). */
export function mitParams(
  pfad: string,
  sp: Record<string, string | string[] | undefined>,
  aenderung: Record<string, string | null | undefined>,
): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const wert = Array.isArray(v) ? v[0] : v;
    if (wert != null && wert !== '') p.set(k, wert);
  }
  for (const [k, v] of Object.entries(aenderung)) {
    if (v == null || v === '') p.delete(k);
    else p.set(k, v);
  }
  const q = p.toString();
  return q ? `${pfad}?${q}` : pfad;
}

export function param(sp: Record<string, string | string[] | undefined>, k: string): string {
  const v = sp[k];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}
