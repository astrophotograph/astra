import {getDatabaseConfig} from '@/lib/database/config'
import {getDefaultUserId} from '@/lib/database'

/**
 * Check if SQLite auto-login should be used
 */
export const shouldUseSQLiteAutoLogin = (): boolean => {
  try {
    const config = getDatabaseConfig();
    return config.dialect === 'sqlite';
  } catch (error) {
    console.error('Error checking SQLite auto-login:', error);
    return false;
  }
};

/**
 * Get the SQLite auto-login user ID
 */
export const getSQLiteAutoLoginUserId = async (): Promise<string | null> => {
  try {
    if (!shouldUseSQLiteAutoLogin()) {
      console.log('SQLite auto-login not enabled');
      return null;
    }

    return await getDefaultUserId();
  } catch (error) {
    console.error('Error getting SQLite auto-login user ID:', error);
    return null;
  }
};
/**
 * Auto-login for SQLite database
 * Returns the default user ID if using SQLite
 */
// export const getSQLiteAutoLoginUserId = async (): Promise<string | null> => {
//   try {
//     // Ensure database is initialized first
//     await ensureDatabaseInitialized();
//
//     const config = getDatabaseConfig();
//
//     if (config.dialect === 'sqlite') {
//       const userId = await getDefaultUserId();
//       if (userId) {
//         console.log('Auto-login with SQLite default user:', userId);
//         return userId;
//       }
//     }
//
//     return null;
//   } catch (error) {
//     console.error('Failed to get SQLite auto-login user:', error);
//     return null;
//   }
// };

/**
 * Check if we should use SQLite auto-login
 */
// export const shouldUseSQLiteAutoLogin = (): boolean => {
//   const config = getDatabaseConfig();
//   return config.dialect === 'sqlite';
// };
