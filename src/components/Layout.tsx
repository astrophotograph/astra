import { Outlet, Link, useLocation } from "react-router-dom";
import { Search } from "lucide-react";

export default function Layout() {
  const location = useLocation();
  const isHomePage = location.pathname === "/";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-slate-900/95 backdrop-blur">
        <div className="container flex h-14 max-w-screen-2xl items-center justify-between px-4">
          <Link to="/" className="flex items-center">
            <span className="text-lg font-bold text-white">Astro Log Book</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link
              to="/"
              className="text-sm text-gray-300 hover:text-white transition-colors"
            >
              Home
            </Link>
            <div className="relative">
              <div className="flex items-center gap-2 rounded-md bg-slate-800/80 px-3 py-1.5 text-sm text-gray-400">
                <Search className="h-4 w-4" />
                <span>Search...</span>
                <div className="flex items-center gap-0.5 ml-4">
                  <kbd className="rounded bg-slate-700 px-1.5 py-0.5 text-xs">⌘</kbd>
                  <kbd className="rounded bg-slate-700 px-1.5 py-0.5 text-xs">K</kbd>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>
      <main className={`flex-1 ${isHomePage ? "" : "container max-w-screen-2xl py-6 px-4 md:px-6 lg:px-8"}`}>
        <Outlet />
      </main>
    </div>
  );
}
