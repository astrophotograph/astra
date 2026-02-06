'use client'

import { useAuthMode } from "./useAuthMode";

/**
 * Hook that provides auth information based on the current auth mode
 * Returns SQLite default values when in SQLite mode, loading state otherwise
 */
export function useConditionalAuth() {
  const { isSQLite, isLoading: authModeLoading, error } = useAuthMode();
  
  // While checking auth mode, return loading state
  if (authModeLoading) {
    return {
      userId: null,
      isLoaded: false,
      isSignedIn: false,
      user: null,
      effectiveUserId: null,
      effectiveIsSignedIn: false,
      effectiveIsLoaded: false,
    };
  }
  
  // If there's an error checking auth mode, assume SQLite
  if (error || isSQLite) {
    return {
      userId: null,
      isLoaded: true,
      isSignedIn: false,
      user: null,
      effectiveUserId: 'sqlite-default-user',
      effectiveIsSignedIn: true,
      effectiveIsLoaded: true,
    };
  }
  
  // For non-SQLite mode, return default values and let the component handle Clerk
  return {
    userId: null,
    isLoaded: false,
    isSignedIn: false,
    user: null,
    effectiveUserId: null,
    effectiveIsSignedIn: false,
    effectiveIsLoaded: false,
  };
}