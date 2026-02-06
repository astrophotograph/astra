'use client'

import { useEffect, useState } from 'react';

interface AuthModeResult {
  isSQLite: boolean;
  isLoading: boolean;
  error: string | null;
}

/**
 * Custom hook to check if we're in SQLite mode
 * This makes an API call to avoid client-side environment variable access
 */
export const useAuthMode = (): AuthModeResult => {
  const [isSQLite, setIsSQLite] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const checkAuthMode = async () => {
      try {
        const response = await fetch('/api/auth/mode');
        if (!response.ok) {
          throw new Error('Failed to check auth mode');
        }
        const data = await response.json();
        setIsSQLite(data.isSQLite);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
        console.error('Error checking auth mode:', err);
      } finally {
        setIsLoading(false);
      }
    };

    checkAuthMode();
  }, []);

  return { isSQLite, isLoading, error };
};
