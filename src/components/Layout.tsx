import { useState, useEffect, useRef } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { Loader2, MapPin, Search } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useLocations } from "@/contexts/LocationContext";
import SearchDialog from "./SearchDialog";

export default function Layout() {
  const location = useLocation();
  const isHomePage = location.pathname === "/";
  const [searchOpen, setSearchOpen] = useState(false);
  const { locations, activeLocation, setActiveLocationId } = useLocations();

  // Auto-import progress toast
  const [importProgress, setImportProgress] = useState<{
    step: string; detail: string; imageName?: string;
  } | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unlisten = listen<{ step: string; detail: string; imageName?: string }>(
      "auto-import-progress",
      (event) => {
        setImportProgress(event.payload);
        // Clear any pending hide timer
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      }
    );

    // Also listen for status to know when scan completes
    const unlistenStatus = listen<{ lastImportCount: number; isScanning: boolean }>(
      "auto-import-status",
      (event) => {
        if (!event.payload.isScanning && importProgress) {
          const count = event.payload.lastImportCount;
          if (count > 0) {
            setImportProgress({
              step: "done",
              detail: `Imported ${count} new image${count !== 1 ? "s" : ""}`,
            });
          }
          // Hide after 3 seconds
          hideTimerRef.current = setTimeout(() => setImportProgress(null), 3000);
        }
      }
    );

    return () => {
      unlisten.then((fn) => fn());
      unlistenStatus.then((fn) => fn());
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [importProgress]);

  // Global keyboard shortcut for search (Cmd+K or Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-slate-900/95 backdrop-blur">
        <div className="flex h-14 w-full items-center justify-between px-4 md:px-6 lg:px-8">
          <Link to="/" className="flex items-center">
            <span className="text-lg font-bold text-white">Astra</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link
              to="/"
              className="text-sm text-gray-300 hover:text-white transition-colors"
            >
              Home
            </Link>
            <Link
              to="/observations"
              className="text-sm text-gray-300 hover:text-white transition-colors"
            >
              Observations
            </Link>
            <Link
              to="/collections"
              className="text-sm text-gray-300 hover:text-white transition-colors"
            >
              Collections
            </Link>
            <Link
              to="/images"
              className="text-sm text-gray-300 hover:text-white transition-colors"
            >
              Images
            </Link>
            <Link
              to="/targets"
              className="text-sm text-gray-300 hover:text-white transition-colors"
            >
              Targets
            </Link>
            <Link
              to="/todo"
              className="text-sm text-gray-300 hover:text-white transition-colors"
            >
              Todo
            </Link>
            <Link
              to="/plan"
              className="text-sm text-gray-300 hover:text-white transition-colors"
            >
              Planning
            </Link>
            <Link
              to="/settings"
              className="text-sm text-gray-300 hover:text-white transition-colors"
            >
              Settings
            </Link>

            {/* Location Switcher - only show if multiple locations */}
            {locations.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-gray-300 hover:text-white gap-2">
                    <MapPin className="h-4 w-4" />
                    <span className="max-w-[120px] truncate">
                      {activeLocation?.name || "No Location"}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {locations.map((loc) => (
                    <DropdownMenuItem
                      key={loc.id}
                      onClick={() => setActiveLocationId(loc.id)}
                      className={loc.id === activeLocation?.id ? "bg-accent" : ""}
                    >
                      <MapPin className="h-4 w-4 mr-2" />
                      {loc.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Single location indicator */}
            {locations.length === 1 && activeLocation && (
              <div className="flex items-center gap-1 text-sm text-gray-400">
                <MapPin className="h-3 w-3" />
                <span className="max-w-[120px] truncate">{activeLocation.name}</span>
              </div>
            )}

            <button
              onClick={() => setSearchOpen(true)}
              className="relative"
            >
              <div className="flex items-center gap-2 rounded-md bg-slate-800/80 px-3 py-1.5 text-sm text-gray-400 hover:bg-slate-700/80 transition-colors cursor-pointer">
                <Search className="h-4 w-4" />
                <span>Search...</span>
                <div className="flex items-center gap-0.5 ml-4">
                  <kbd className="rounded bg-slate-700 px-1.5 py-0.5 text-xs">⌘</kbd>
                  <kbd className="rounded bg-slate-700 px-1.5 py-0.5 text-xs">K</kbd>
                </div>
              </div>
            </button>
          </div>
        </div>
      </header>
      <main className={`flex-1 ${isHomePage ? "" : "container max-w-screen-2xl mx-auto py-6 px-4 md:px-6 lg:px-8"}`}>
        <Outlet />
      </main>

      {/* Global Search Dialog */}
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />

      {/* Auto-import progress toast */}
      {importProgress && (
        <div className="fixed bottom-4 right-4 z-50 bg-slate-800/95 backdrop-blur border border-slate-700 rounded-lg shadow-xl px-4 py-3 min-w-[280px] max-w-[360px] animate-in slide-in-from-bottom-2">
          <div className="flex items-center gap-3">
            {importProgress.step !== "done" ? (
              <Loader2 className="w-4 h-4 animate-spin text-indigo-400 shrink-0" />
            ) : (
              <div className="w-4 h-4 rounded-full bg-emerald-500 shrink-0" />
            )}
            <div className="min-w-0">
              <p className="text-sm text-white font-medium truncate">
                {importProgress.step === "scanning" && "Scanning..."}
                {importProgress.step === "found" && "New image found"}
                {importProgress.step === "stretching" && "Generating preview"}
                {importProgress.step === "plate-solving" && "Plate solving"}
                {importProgress.step === "done" && "Import complete"}
              </p>
              <p className="text-xs text-slate-400 truncate">
                {importProgress.imageName || importProgress.detail}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
