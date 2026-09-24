export function normalizeName(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

export function songKey(artist: string, track: string): string {
  return `${normalizeName(artist)}\u0000${normalizeName(track)}`;
}
