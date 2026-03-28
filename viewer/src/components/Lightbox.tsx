import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import type { ManifestImage } from "../types";
import { raToHMS, decToDMS, formatDateTime } from "../utils";

interface Props {
  images: ManifestImage[];
  currentIndex: number;
  onClose: () => void;
  onNav: (dir: number) => void;
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div class="lb-info-item">
      <div class="label">{label}</div>
      <div class="value">{value}</div>
    </div>
  );
}

export function Lightbox({ images, currentIndex, onClose, onNav }: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [imgLoading, setImgLoading] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const touchRef = useRef({ startX: 0, startY: 0, deltaX: 0, swiping: false });

  const img = images[currentIndex];

  // Reset loading state on image change
  useEffect(() => {
    setImgLoading(true);
  }, [currentIndex]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onNav(-1);
      else if (e.key === "ArrowRight") onNav(1);
      else if (e.key === "i" || e.key === "I")
        setDetailsOpen((v) => !v);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, onNav]);

  // Touch swipe handlers
  const onTouchStart = useCallback((e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = touchRef.current;
    t.startX = e.touches[0].clientX;
    t.startY = e.touches[0].clientY;
    t.deltaX = 0;
    t.swiping = false;
  }, []);

  const onTouchMove = useCallback((e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = touchRef.current;
    t.deltaX = e.touches[0].clientX - t.startX;
    const deltaY = Math.abs(e.touches[0].clientY - t.startY);
    if (Math.abs(t.deltaX) > deltaY && Math.abs(t.deltaX) > 10) {
      t.swiping = true;
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    const t = touchRef.current;
    if (!t.swiping) return;
    if (Math.abs(t.deltaX) > 50) {
      onNav(t.deltaX > 0 ? -1 : 1);
    }
    t.swiping = false;
  }, [onNav]);

  // Click backdrop to close
  const handleBodyClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === bodyRef.current) onClose();
    },
    [onClose]
  );

  if (!img) return null;

  const ps = img.plateSolve;

  return (
    <div class="lightbox open">
      <div class="lb-top-bar">
        <span class="lb-counter">
          {currentIndex + 1} / {images.length}
        </span>
        <button class="close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>
      <div
        class="lb-body"
        ref={bodyRef}
        onClick={handleBodyClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <button class="nav prev" onClick={() => onNav(-1)} aria-label="Previous">
          &#8249;
        </button>
        <button class="nav next" onClick={() => onNav(1)} aria-label="Next">
          &#8250;
        </button>
        <img
          src={img.imagePath}
          alt={img.summary || img.filename}
          class={imgLoading ? "lb-loading" : ""}
          onLoad={() => setImgLoading(false)}
        />
      </div>
      <div class="lb-details">
        <button
          class="lb-details-toggle"
          onClick={() => setDetailsOpen((v) => !v)}
        >
          <span class={`arrow ${detailsOpen ? "open" : ""}`}>&#9654;</span>{" "}
          Image details
        </button>
        {detailsOpen && (
          <div class="lb-details-content open">
            <div class="lb-summary">
              <span class="title">{img.summary || img.filename}</span>
              {img.favorite && <span class="fav">&#9733;</span>}
              {img.createdAt && (
                <span class="date">{formatDateTime(img.createdAt)}</span>
              )}
            </div>
            {ps && (
              <div class="lb-info-grid">
                <InfoItem label="Right Ascension" value={raToHMS(ps.centerRa)} />
                <InfoItem label="Declination" value={decToDMS(ps.centerDec)} />
                {ps.widthDeg != null && ps.heightDeg != null && (
                  <InfoItem
                    label="Field of View"
                    value={`${(ps.widthDeg * 60).toFixed(1)}' \u00d7 ${(ps.heightDeg * 60).toFixed(1)}'`}
                  />
                )}
                {ps.pixelScale != null && (
                  <InfoItem
                    label="Pixel Scale"
                    value={`${ps.pixelScale.toFixed(2)}"/px`}
                  />
                )}
                {ps.rotation != null && (
                  <InfoItem
                    label="Rotation"
                    value={`${ps.rotation.toFixed(1)}\u00b0`}
                  />
                )}
                {ps.imageWidth && ps.imageHeight && (
                  <InfoItem
                    label="Resolution"
                    value={`${ps.imageWidth} \u00d7 ${ps.imageHeight}`}
                  />
                )}
              </div>
            )}
            {img.objects && img.objects.length > 0 && (
              <div class="lb-objects">
                <div class="lb-objects-title">Objects in field</div>
                <div class="lb-objects-list">
                  {img.objects.map((obj) => (
                    <span key={obj.name} class="lb-object-tag">
                      {obj.name}
                      {obj.magnitude != null && (
                        <span class="mag"> mag {obj.magnitude.toFixed(1)}</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
