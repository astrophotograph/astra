import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { isTauri } from "./lib/tauri/transport";
import {
  beginLogin,
  completeLogin,
  fetchMe,
  type SessionUser,
} from "./lib/auth-web";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
});

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="dark flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-100">
      {children}
    </div>
  );
}

/** /auth/callback lives outside the /app router basename; finish the code
 *  exchange here, then enter the app. */
function AuthCallback() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    completeLogin()
      .then(() => window.location.replace("/app"))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <Shell>
      {error ? (
        <div className="max-w-md space-y-4 rounded-lg border border-zinc-800 p-8 text-center">
          <h1 className="text-lg font-semibold">Sign-in failed</h1>
          <p className="text-sm text-zinc-400">{error}</p>
          <a className="inline-block text-sm text-sky-400 hover:underline" href="/app">
            Back to sign-in
          </a>
        </div>
      ) : (
        <p className="text-sm text-zinc-400">Completing sign-in…</p>
      )}
    </Shell>
  );
}

function SignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Shell>
      <div className="max-w-md space-y-6 rounded-lg border border-zinc-800 p-10 text-center">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Astra</h1>
          <p className="text-sm text-zinc-400">Observation log &amp; gallery</p>
        </div>
        <button
          className="w-full rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            beginLogin().catch((e: unknown) => {
              setError(e instanceof Error ? e.message : String(e));
              setBusy(false);
            });
          }}
        >
          {busy ? "Redirecting…" : "Sign in"}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </Shell>
  );
}

/** Cookie-session gate for the browser build. Desktop renders App directly. */
function WebAuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<SessionUser | null | "loading">("loading");

  useEffect(() => {
    fetchMe()
      .then(setSession)
      .catch(() => setSession(null));
  }, []);

  if (session === "loading") {
    return (
      <Shell>
        <p className="text-sm text-zinc-400">Loading…</p>
      </Shell>
    );
  }
  if (session === null) return <SignIn />;
  // Sign-out lives in Settings → Account.
  return <>{children}</>;
}

function Root() {
  if (isTauri()) return <App />;
  return (
    <WebAuthGate>
      <App />
    </WebAuthGate>
  );
}

// /auth/callback is outside the /app basename — render it without the
// router so the exchange finishes before any routing happens.
const onAuthCallback = !isTauri() && window.location.pathname === "/auth/callback";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {onAuthCallback ? (
        <AuthCallback />
      ) : (
        // The daemon serves the browser build under /app; desktop stays at /.
        <BrowserRouter basename={isTauri() ? undefined : "/app"}>
          <Root />
        </BrowserRouter>
      )}
    </QueryClientProvider>
  </React.StrictMode>
);
