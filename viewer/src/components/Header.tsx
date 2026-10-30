import { useEffect, useState } from "preact/hooks";
import type { ShareManifest } from "../types";
import { formatDate } from "../utils";

/**
 * The collection's `at://` URI with a copy button. Only a signed gallery
 * has one: this is the link that survives a host move (the daemon's
 * `/at/{did}/{collection}/{rkey}` route resolves it back to the gallery).
 */
function AtUri({ uri }: { uri: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
    } catch {
      // Clipboard unavailable (insecure context, denied): the text is
      // selectable, so there is nothing more to do.
    }
  };

  return (
    <div class="identity" title="Canonical record URI">
      <code class="at-uri">{uri}</code>
      <button
        type="button"
        class="copy-btn"
        onClick={copy}
        aria-label="Copy record URI"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

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
      {m.atUri && <AtUri uri={m.atUri} />}
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
