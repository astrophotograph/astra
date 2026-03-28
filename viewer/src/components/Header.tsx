import type { ShareManifest } from "../types";
import { formatDate } from "../utils";

interface Props {
  manifest: ShareManifest;
}

export function Header({ manifest }: Props) {
  const m = manifest;
  const pct =
    m.template === "messier" ? Math.round((m.imageCount / 110) * 100) : null;

  let dateRange = "";
  if (m.dateRangeStart && m.dateRangeEnd) {
    dateRange = `${formatDate(m.dateRangeStart)} \u2013 ${formatDate(m.dateRangeEnd)}`;
  } else if (m.dateRangeStart) {
    dateRange = `Since ${formatDate(m.dateRangeStart)}`;
  }

  return (
    <header class="header">
      <h1>{m.collectionName}</h1>
      {m.collectionDescription && (
        <p class="description">{m.collectionDescription}</p>
      )}
      <div class="meta">
        <span>
          {m.imageCount} image{m.imageCount !== 1 ? "s" : ""}
        </span>
        {dateRange && <span>{dateRange}</span>}
        <span>Updated {new Date(m.updatedAt).toLocaleString()}</span>
      </div>
      {pct !== null && (
        <div class="progress-section">
          <div class="progress-bar">
            <div class="fill" style={{ width: `${pct}%` }} />
          </div>
          <div class="progress-label">
            {m.imageCount} / 110 Messier objects ({pct}%)
          </div>
        </div>
      )}
    </header>
  );
}
