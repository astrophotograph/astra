import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Play, Pause, X } from "lucide-react";
import { imageApi, type Image } from "@/lib/tauri/commands";
import { useCollectionImages } from "@/hooks/use-images";
import { useSlideshow } from "@/hooks/use-slideshow";

// LRU cache for preloaded image data URLs
const imageCache = new Map<string, string>();
const CACHE_SIZE = 5;

function cacheSet(id: string, data: string) {
  if (imageCache.has(id)) {
    imageCache.delete(id);
  }
  imageCache.set(id, data);
  // Evict oldest
  if (imageCache.size > CACHE_SIZE) {
    const oldest = imageCache.keys().next().value;
    if (oldest) imageCache.delete(oldest);
  }
}

/** Shuffle an array with Fisher-Yates */
function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Parse plate_solve metadata from an image */
function getPlateSolveData(image: Image) {
  if (!image.metadata) return null;
  try {
    const meta = typeof image.metadata === "string" ? JSON.parse(image.metadata) : image.metadata;
    return meta.plate_solve ?? null;
  } catch {
    return null;
  }
}

/** Format RA degrees to HH:MM:SS */
function formatRA(deg: number): string {
  const h = deg / 15;
  const hours = Math.floor(h);
  const minutes = Math.floor((h - hours) * 60);
  const seconds = ((h - hours) * 60 - minutes) * 60;
  return `${hours}h ${minutes}m ${seconds.toFixed(1)}s`;
}

/** Format Dec degrees to DD:MM:SS */
function formatDec(deg: number): string {
  const sign = deg >= 0 ? "+" : "-";
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = ((abs - d) * 60 - m) * 60;
  return `${sign}${d}° ${m}' ${s.toFixed(1)}"`;
}

// Transition CSS classes
const TRANSITIONS = {
  fade: {
    active: "opacity-100 transition-opacity duration-700 ease-in-out",
    inactive: "opacity-0 transition-opacity duration-700 ease-in-out",
  },
  slide: {
    active: "translate-x-0 transition-transform duration-700 ease-in-out",
    enter: "translate-x-full",
    exit: "-translate-x-full",
  },
  zoom: {
    active: "scale-100 opacity-100 transition-all duration-700 ease-in-out",
    inactive: "scale-95 opacity-0 transition-all duration-700 ease-in-out",
  },
  none: {
    active: "",
    inactive: "hidden",
  },
};

export default function Slideshow() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Parse config from URL
  const collectionIds = (searchParams.get("collections") || "").split(",").filter(Boolean);
  const transition = (searchParams.get("transition") || "fade") as keyof typeof TRANSITIONS;
  const theme = searchParams.get("theme") || "nameOnly";
  const interval = parseInt(searchParams.get("interval") || "10", 10);
  const shouldShuffle = searchParams.get("shuffle") === "1";

  // Fetch images for all selected collections
  const collectionQueries = collectionIds.map((id) => ({
    id,
    // eslint-disable-next-line react-hooks/rules-of-hooks
    query: useCollectionImages(id),
  }));

  const allImages = useMemo(() => {
    const images: Image[] = [];
    const seen = new Set<string>();
    for (const { query } of collectionQueries) {
      for (const img of query.data ?? []) {
        if (!seen.has(img.id)) {
          seen.add(img.id);
          images.push(img);
        }
      }
    }
    return shouldShuffle ? shuffleArray(images) : images;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionQueries.map((q) => q.query.data).join(","), shouldShuffle]);

  const isLoading = collectionQueries.some((q) => q.query.isLoading);

  const { currentIndex, isPlaying, goNext, goPrev, togglePlay, totalImages } =
    useSlideshow({
      totalImages: allImages.length,
      interval,
      autoPlay: interval > 0,
    });

  const currentImage = allImages[currentIndex] ?? null;

  // Image data loading
  const [displayedDataUrl, setDisplayedDataUrl] = useState<string | null>(null);
  const [isImageLoading, setIsImageLoading] = useState(false);
  const loadingIdRef = useRef<string | null>(null);

  // Load current image data
  const loadImageData = useCallback(async (image: Image) => {
    const id = image.id;
    loadingIdRef.current = id;

    // Check cache first
    if (imageCache.has(id)) {
      setDisplayedDataUrl(imageCache.get(id)!);
      setIsImageLoading(false);
      return;
    }

    setIsImageLoading(true);
    try {
      const data = await imageApi.getData(id);
      if (loadingIdRef.current === id) {
        cacheSet(id, data);
        setDisplayedDataUrl(data);
        setIsImageLoading(false);
      }
    } catch (err) {
      console.error("Failed to load image data:", err);
      if (loadingIdRef.current === id) {
        setIsImageLoading(false);
      }
    }
  }, []);

  // Load current image when index changes
  useEffect(() => {
    if (currentImage) {
      loadImageData(currentImage);
    }
  }, [currentImage, loadImageData]);

  // Preload next image
  useEffect(() => {
    if (allImages.length <= 1) return;
    const nextIndex = (currentIndex + 1) % allImages.length;
    const nextImage = allImages[nextIndex];
    if (nextImage && !imageCache.has(nextImage.id)) {
      imageApi.getData(nextImage.id).then((data) => {
        cacheSet(nextImage.id, data);
      }).catch(() => {});
    }
  }, [currentIndex, allImages]);

  // Controls visibility (auto-hide after 3s)
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, 3000);
  }, []);

  // Initial show then auto-hide
  useEffect(() => {
    showControls();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [showControls]);

  const handleMouseMove = useCallback(() => {
    showControls();
  }, [showControls]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowRight":
          goNext();
          showControls();
          break;
        case "ArrowLeft":
          goPrev();
          showControls();
          break;
        case " ":
          e.preventDefault();
          togglePlay();
          showControls();
          break;
        case "Escape":
          navigate(-1);
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [goNext, goPrev, togglePlay, navigate, showControls]);

  const handleExit = () => {
    navigate(-1);
  };

  // Transition state for image switching
  const [prevDataUrl, setPrevDataUrl] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const prevIndexRef = useRef(0);

  useEffect(() => {
    if (currentIndex !== prevIndexRef.current && displayedDataUrl) {
      setPrevDataUrl(displayedDataUrl);
      setTransitioning(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            setTransitioning(false);
            setPrevDataUrl(null);
          }, 750);
        });
      });
      prevIndexRef.current = currentIndex;
    }
  }, [currentIndex, displayedDataUrl]);

  // Loading state
  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
        <p className="text-white text-lg">Loading images...</p>
      </div>
    );
  }

  if (allImages.length === 0) {
    return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center z-50 gap-4">
        <p className="text-white text-lg">No images found in selected collections.</p>
        <button
          onClick={handleExit}
          className="px-4 py-2 bg-slate-700 text-white rounded hover:bg-slate-600"
        >
          Go Back
        </button>
      </div>
    );
  }

  // Determine what to show for the image source
  const imageSrc = displayedDataUrl || currentImage?.thumbnail || null;

  // Info overlay data
  const plateSolve = currentImage ? getPlateSolveData(currentImage) : null;

  return (
    <div
      className="fixed inset-0 bg-black z-50 select-none"
      onMouseMove={handleMouseMove}
      style={{ cursor: controlsVisible ? "default" : "none" }}
    >
      {/* Image display */}
      <div className="absolute inset-0 flex items-center justify-center">
        {/* Previous image (for transition) */}
        {transitioning && prevDataUrl && transition !== "none" && (
          <img
            src={prevDataUrl}
            alt=""
            className={`absolute max-w-full max-h-full object-contain ${
              transition === "fade" ? TRANSITIONS.fade.inactive :
              transition === "slide" ? `${TRANSITIONS.slide.exit} transition-transform duration-700 ease-in-out` :
              transition === "zoom" ? TRANSITIONS.zoom.inactive :
              "hidden"
            }`}
          />
        )}

        {/* Current image */}
        {imageSrc && (
          <img
            src={imageSrc}
            alt={currentImage?.summary || currentImage?.filename || ""}
            className={`absolute max-w-full max-h-full object-contain ${
              transition === "fade" ? TRANSITIONS.fade.active :
              transition === "slide" ? TRANSITIONS.slide.active :
              transition === "zoom" ? TRANSITIONS.zoom.active :
              ""
            }`}
          />
        )}

        {/* Loading indicator while full image loads */}
        {isImageLoading && currentImage?.thumbnail && (
          <div className="absolute bottom-20 left-1/2 -translate-x-1/2">
            <div className="px-3 py-1.5 bg-black/60 rounded-full text-xs text-gray-300">
              Loading full resolution...
            </div>
          </div>
        )}
      </div>

      {/* Info overlay (top-left, always visible when enabled) */}
      {theme !== "nothing" && currentImage && (
        <div className="absolute top-6 left-6">
          <div className="bg-black/60 backdrop-blur-sm rounded-lg px-4 py-3 max-w-sm">
            <p className="text-white font-medium text-lg">
              {currentImage.summary || currentImage.filename}
            </p>
            {theme === "nameDetails" && (
              <div className="mt-1 space-y-0.5 text-sm text-gray-300">
                {plateSolve && (
                  <p>
                    RA: {formatRA(plateSolve.centerRa)} / Dec: {formatDec(plateSolve.centerDec)}
                  </p>
                )}
                {currentImage.description && (
                  <p className="text-gray-400">{currentImage.description}</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Controls bar (bottom) */}
      <div
        className={`absolute bottom-0 left-0 right-0 transition-opacity duration-300 ${
          controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <div className="bg-gradient-to-t from-black/80 to-transparent pt-16 pb-6 px-6">
          <div className="flex items-center justify-center gap-4">
            <button
              onClick={goPrev}
              className="p-2 rounded-full hover:bg-white/10 text-white transition-colors"
              title="Previous (Left Arrow)"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>

            <button
              onClick={togglePlay}
              className="p-3 rounded-full hover:bg-white/10 text-white transition-colors"
              title={isPlaying ? "Pause (Space)" : "Play (Space)"}
            >
              {isPlaying ? (
                <Pause className="w-6 h-6" />
              ) : (
                <Play className="w-6 h-6" />
              )}
            </button>

            <button
              onClick={goNext}
              className="p-2 rounded-full hover:bg-white/10 text-white transition-colors"
              title="Next (Right Arrow)"
            >
              <ChevronRight className="w-6 h-6" />
            </button>

            <span className="text-white/70 text-sm ml-4 tabular-nums">
              {currentIndex + 1} / {totalImages}
            </span>

            <button
              onClick={handleExit}
              className="p-2 rounded-full hover:bg-white/10 text-white transition-colors ml-auto"
              title="Exit (Escape)"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
