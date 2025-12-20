import {auth} from '@clerk/nextjs/server'
import {getSQLiteAutoLoginUserId} from './sqlite'
import {User} from '@/lib/database'
import {fetchUserFromClerkUser} from '@/lib/db'
import {shouldUseSQLiteAutoLoginServer} from './server'

export interface AuthResult {
  userId: string | null;
  user: any;
  isAuthenticated: boolean;
}

/**
 * Unified authentication function that handles both Clerk and SQLite modes
 * This should only be used on the server side
 */
export const getAuthenticatedUser = async (): Promise<AuthResult> => {
  try {
    if (shouldUseSQLiteAutoLoginServer()) {
      // SQLite mode - use default user
      const userId = await getSQLiteAutoLoginUserId();
      if (userId) {
        const user = await User.findByPk(userId);
        if (user) {
          return {
            userId,
            user,
            isAuthenticated: true
          };
        }
      }

      console.log('SQLite user ID not found')
      return {
        userId: null,
        user: null,
        isAuthenticated: false
      };
    } else {
      // Clerk mode - require authentication
      const authResult = await auth();
      const userId = authResult.userId;

      if (!userId) {
        console.log('Clerk authentication failed. User ID is null.')
        return {
          userId: null,
          user: null,
          isAuthenticated: false
        };
      }

      const user = await fetchUserFromClerkUser(userId);
      return {
        userId,
        user,
        isAuthenticated: !!user
      };
    }
  } catch (error) {
    console.error('Authentication error:', error);
    return {
      userId: null,
      user: null,
      isAuthenticated: false
    };
  }
};

/**
 * Check if the current setup uses SQLite (server-side only)
 */
export const isSQLiteMode = (): boolean => {
  return shouldUseSQLiteAutoLoginServer();
};
