/**
 * App settings hook - manages feature flags and developer mode
 */

import { useCallback, useSyncExternalStore } from "react";

const DEVELOPER_MODE_KEY = "developer_mode";

// Simple external store for cross-component reactivity
let listeners: Array<() => void> = [];
function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getDeveloperMode() {
  return localStorage.getItem(DEVELOPER_MODE_KEY) === "true";
}

export function useSettings() {
  const developerMode = useSyncExternalStore(subscribe, getDeveloperMode);

  const setDeveloperMode = useCallback((enabled: boolean) => {
    localStorage.setItem(DEVELOPER_MODE_KEY, String(enabled));
    emitChange();
  }, []);

  return { developerMode, setDeveloperMode };
}
