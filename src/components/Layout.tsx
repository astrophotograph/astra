import { Outlet, Link } from "react-router-dom";
import { Telescope, Calendar, ListTodo, Map, Settings, FolderOpen } from "lucide-react";

export default function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 max-w-screen-2xl items-center">
          <div className="mr-4 flex">
            <Link to="/" className="mr-6 flex items-center space-x-2">
              <Telescope className="h-6 w-6" />
              <span className="font-bold">Astra</span>
            </Link>
            <nav className="flex items-center gap-4 text-sm lg:gap-6">
              <Link
                to="/observations"
                className="flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <Calendar className="h-4 w-4" />
                <span className="hidden sm:inline">Observations</span>
              </Link>
              <Link
                to="/todo"
                className="flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <ListTodo className="h-4 w-4" />
                <span className="hidden sm:inline">Todo</span>
              </Link>
              <Link
                to="/collections"
                className="flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <FolderOpen className="h-4 w-4" />
                <span className="hidden sm:inline">Collections</span>
              </Link>
              <Link
                to="/plan"
                className="flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <Map className="h-4 w-4" />
                <span className="hidden sm:inline">Plan</span>
              </Link>
              <Link
                to="/admin"
                className="flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <Settings className="h-4 w-4" />
                <span className="hidden sm:inline">Admin</span>
              </Link>
            </nav>
          </div>
        </div>
      </header>
      <main className="flex-1 container max-w-screen-2xl py-6 px-4 md:px-6 lg:px-8">
        <Outlet />
      </main>
      <footer className="border-t border-border/40 py-4 text-center text-sm text-muted-foreground">
        Astra - Astronomy Observation Log
      </footer>
    </div>
  );
}
