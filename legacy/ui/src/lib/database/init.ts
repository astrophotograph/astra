import {initializeDatabase} from './index'

// Track if database has been initialized
let isInitialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Ensure database is initialized exactly once
 */
export const ensureDatabaseInitialized = async (): Promise<void> => {
  if (isInitialized) {
    return;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      await initializeDatabase();
      isInitialized = true;
      console.log('Database initialization completed.');
    } catch (error) {
      console.error('Database initialization failed:', error);
      initPromise = null; // Reset to allow retry
      throw error;
    }
  })();

  return initPromise;
};

/**
 * Check if database is initialized
 */
export const isDatabaseInitialized = (): boolean => {
  return isInitialized;
};
