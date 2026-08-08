/**
 * Desktop plate-solver configuration, persisted in localStorage like every
 * other desktop setting (equipment, locations, tetra3 path, API key).
 *
 * The fallback chain is stored as an ordered list of solver ids; per-solver
 * credentials/paths live under their existing keys and are assembled into
 * self-describing `SolverChainEntry` objects at solve time.
 */

import type { SolverChainEntry } from "./tauri/commands";

const CHAIN_KEY = "plate_solve_chain";
const ASTAP_PATH_KEY = "astap_path";
const SOLVE_FIELD_PATH_KEY = "solve_field_path";

export const SOLVER_IDS = ["tetra3", "nova", "local", "astap"] as const;
export type SolverId = (typeof SOLVER_IDS)[number];

export const SOLVER_LABELS: Record<SolverId, string> = {
  tetra3: "Tetra3 (built-in)",
  nova: "Nova (astrometry.net API)",
  local: "Local (solve-field)",
  astap: "ASTAP",
};

/** The ordered fallback chain; empty = single-solver behavior. */
export function loadSolverChain(): SolverId[] {
  try {
    const raw = localStorage.getItem(CHAIN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is SolverId =>
      (SOLVER_IDS as readonly string[]).includes(s),
    );
  } catch {
    return [];
  }
}

export function saveSolverChain(chain: SolverId[]): void {
  localStorage.setItem(CHAIN_KEY, JSON.stringify(chain));
}

export function loadAstapPath(): string {
  return localStorage.getItem(ASTAP_PATH_KEY) || "";
}

export function saveAstapPath(path: string): void {
  if (path) localStorage.setItem(ASTAP_PATH_KEY, path);
  else localStorage.removeItem(ASTAP_PATH_KEY);
}

export function loadSolveFieldPath(): string {
  return localStorage.getItem(SOLVE_FIELD_PATH_KEY) || "";
}

export function saveSolveFieldPath(path: string): void {
  if (path) localStorage.setItem(SOLVE_FIELD_PATH_KEY, path);
  else localStorage.removeItem(SOLVE_FIELD_PATH_KEY);
}

/** Assemble a self-describing chain entry for one solver from the stored
 *  per-solver settings. */
export function buildChainEntry(
  solver: SolverId,
  timeout?: number,
): SolverChainEntry {
  return {
    solver,
    apiKey: localStorage.getItem("astrometry_api_key") || undefined,
    apiUrl: localStorage.getItem("local_astrometry_url") || undefined,
    tetra3DbPath: localStorage.getItem("tetra3_db_path") || undefined,
    binaryPath:
      solver === "astap"
        ? loadAstapPath() || undefined
        : solver === "local"
          ? loadSolveFieldPath() || undefined
          : undefined,
    timeout,
  };
}

/** The full chain as solve-ready entries, or undefined when no chain is
 *  configured (legacy single-solver behavior). */
export function buildChainEntries(timeout?: number): SolverChainEntry[] | undefined {
  const chain = loadSolverChain();
  if (chain.length === 0) return undefined;
  return chain.map((solver) => buildChainEntry(solver, timeout));
}
