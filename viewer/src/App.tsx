import { useState, useEffect, useCallback, useMemo } from "preact/hooks";
import type { ShareManifest, SortMode } from "./types";
import { parseUsername } from "./utils";
import { TopBar } from "./components/TopBar";
import { Header } from "./components/Header";
import { Toolbar } from "./components/Toolbar";
import { Gallery } from "./components/Gallery";
import { Lightbox } from "./components/Lightbox";
import { Skeleton } from "./components/Skeleton";
import { Footer } from "./components/Footer";
import "./styles.css";

async function fetchManifest(): Promise<ShareManifest | null> {
  try {
    const resp = await fetch("manifest.json?t=" + Date.now());
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

export function App() {
  const [manifest, setManifest] = useState<ShareManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("date-desc");
  const [favOnly, setFavOnly] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(-1);

  const username = useMemo(() => parseUsername(), []);

  // Initial load
  useEffect(() => {
    fetchManifest().then((m) => {
      setManifest(m);
      setLoading(false);
    });
  }, []);

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(async () => {
      const m = await fetchManifest();
      if (!m) return;
      setManifest((prev) => {
        if (
          !prev ||
          m.imageCount !== prev.imageCount ||
          m.updatedAt !== prev.updatedAt
        ) {
          return m;
        }
        return prev;
      });
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // Filter and sort images
  const filteredImages = useMemo(() => {
    if (!manifest) return [];
    let imgs = manifest.images.slice();

    if (favOnly) {
      imgs = imgs.filter((img) => img.favorite);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      imgs = imgs.filter((img) => {
        const name = (img.summary || img.filename || "").toLowerCase();
        const cats = (img.catalogIds || []).join(" ").toLowerCase();
        const objs = (img.objects || [])
          .map((o) => o.name)
          .join(" ")
          .toLowerCase();
        return name.includes(q) || cats.includes(q) || objs.includes(q);
      });
    }

    imgs.sort((a, b) => {
      switch (sortMode) {
        case "date-desc":
          return (
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        case "date-asc":
          return (
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
        case "name-asc":
          return (a.summary || a.filename).localeCompare(
            b.summary || b.filename
          );
        case "name-desc":
          return (b.summary || b.filename).localeCompare(
            a.summary || a.filename
          );
      }
    });

    return imgs;
  }, [manifest, searchQuery, sortMode, favOnly]);

  const openLightbox = useCallback((idx: number) => {
    setLightboxIndex(idx);
  }, []);

  const closeLightbox = useCallback(() => {
    setLightboxIndex(-1);
  }, []);

  const navLightbox = useCallback(
    (dir: number) => {
      setLightboxIndex((prev) => {
        if (prev < 0 || filteredImages.length === 0) return prev;
        return (prev + dir + filteredImages.length) % filteredImages.length;
      });
    },
    [filteredImages.length]
  );

  // Update document title
  useEffect(() => {
    if (manifest) {
      document.title = manifest.collectionName + " \u2014 Astra Gallery";
    }
  }, [manifest]);

  if (loading) {
    return (
      <>
        <TopBar username={username} />
        <header class="header">
          <h1>Loading...</h1>
        </header>
        <Skeleton />
      </>
    );
  }

  if (!manifest) {
    return (
      <>
        <TopBar username={username} />
        <header class="header">
          <h1>Gallery Not Found</h1>
        </header>
      </>
    );
  }

  return (
    <>
      <TopBar username={username} />
      <Header manifest={manifest} />
      <Toolbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        sortMode={sortMode}
        onSortChange={setSortMode}
        favOnly={favOnly}
        onFavToggle={() => setFavOnly((v) => !v)}
        shownCount={filteredImages.length}
      />
      <Gallery
        images={filteredImages}
        onImageClick={openLightbox}
        hasFilters={!!searchQuery || favOnly}
      />
      <Footer username={username} />
      {lightboxIndex >= 0 && (
        <Lightbox
          images={filteredImages}
          currentIndex={lightboxIndex}
          onClose={closeLightbox}
          onNav={navLightbox}
        />
      )}
    </>
  );
}
