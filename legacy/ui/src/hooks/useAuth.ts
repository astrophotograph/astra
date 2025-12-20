'use client'

import { useAuth as useClerkAuth, useUser as useClerkUser } from "@clerk/nextjs";
import { useAuthMode } from "./useAuthMode";

/**
 * Universal auth hook that works in both SQLite and Clerk modes
 * Automatically uses the appropriate auth method based on the database configuration
 */
export function useAuth() {
  const { isSQLite, isLoading: authModeLoading, error } = useAuthMode();
  
  // Always call Clerk hooks to maintain hook order, but handle errors gracefully
  const clerkAuth = useClerkAuth();
  const clerkUser = useClerkUser();
  
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
      isSQLiteMode: false,
    };
  }
  
  // SQLite mode or Clerk error - use default SQLite user
  if (error || isSQLite) {
    return {
      userId: null,
      isLoaded: true,
      isSignedIn: false,
      user: null,
      effectiveUserId: 'sqlite-default-user',
      effectiveIsSignedIn: true,
      effectiveIsLoaded: true,
      isSQLiteMode: true,
    };
  }
  
  // Clerk mode - use actual Clerk auth
  return {
    userId: clerkAuth?.userId || null,
    isLoaded: clerkAuth?.isLoaded || false,
    isSignedIn: clerkAuth?.isSignedIn || false,
    user: clerkUser?.user || null,
    effectiveUserId: clerkAuth?.userId || null,
    effectiveIsSignedIn: clerkAuth?.isSignedIn || false,
    effectiveIsLoaded: clerkAuth?.isLoaded || false,
    isSQLiteMode: false,
  };
}