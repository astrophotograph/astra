export function raToHMS(ra: number): string {
  const h = Math.floor(ra / 15);
  const m = Math.floor((ra / 15 - h) * 60);
  const s = ((ra / 15 - h) * 60 - m) * 60;
  return `${h}h ${m}m ${s.toFixed(1)}s`;
}

export function decToDMS(dec: number): string {
  const sign = dec >= 0 ? "+" : "-";
  const abs = Math.abs(dec);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = ((abs - d) * 60 - m) * 60;
  return `${sign}${d}\u00b0 ${m}' ${s.toFixed(1)}"`;
}

export function formatDate(str: string | null): string {
  if (!str) return "";
  return new Date(str).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function formatDateTime(str: string | null): string {
  if (!str) return "";
  const d = new Date(str);
  return (
    d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    }) +
    " at " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  );
}

export function parseUsername(): string | null {
  const match = window.location.pathname.match(/^\/@([^/]+)/);
  return match ? match[1] : null;
}
