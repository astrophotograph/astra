import { useState, useEffect } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { MapPin, Search } from "lucide-react";
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
        <div className="container flex h-14 max-w-screen-2xl items-center justify-between px-4">
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
      <main className={`flex-1 ${isHomePage ? "" : "container max-w-screen-2xl py-6 px-4 md:px-6 lg:px-8"}`}>
        <Outlet />
      </main>

      {/* Global Search Dialog */}
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
