// Import sequelize connection
import {sequelize} from './connection'
// Import associations after all models are defined
import './associations'
import {initializeAssociations} from './associations'
import {initializeSQLite} from './hooks'
import {User} from './models/User'
import {getDatabaseConfig} from './config'
import {startPeriodicBackups, stopPeriodicBackups} from './scheduler'

export { sequelize, withTransaction, getSequelize, Op, Transaction, QueryTypes } from './connection';

// Import all models to register them
export * from './models/User';
export * from './models/AstronomyTodo';
export * from './models/AstroObject';
export * from './models/Collection';
export * from './models/Image';
export * from './models/ObservationSchedule';

// Create default user for SQLite
const createDefaultUser = async (): Promise<string | null> => {
  const config = getDatabaseConfig();

  if (config.dialect === 'sqlite') {
    try {
      let user = await User.findOne();

      if (!user) {
        user = await User.create({
          name: 'Default User',
          email: 'user@example.com',
          metadata_: {
            'default': true,
            'created_by': 'system'
          }
        });
        console.log('Default user created for SQLite database.');
      }

      return user.id;
    } catch (error) {
      console.error('Failed to create default user:', error);
      return null;
    }
  }

  return null;
};

// Get default user ID for SQLite
export const getDefaultUserId = async (): Promise<string | null> => {
  const config = getDatabaseConfig();

  if (config.dialect === 'sqlite') {
    try {
      const user = await User.findOne();
      //   await User.findOne({
      //   where: {
      //     metadata_: {
      //       [sequelize.literal("JSON_EXTRACT(metadata_, '$.default')")]: true
      //     }
      //   }
      // }) ||

      return user?.id || null;
    } catch (error) {
      console.error('Failed to get default user:', error);
      return null;
    }
  }

  return null;
};

// Test connection and sync models
export const initializeDatabase = async (): Promise<void> => {
  try {
    await sequelize.authenticate();
    console.log('Database connection has been established successfully.');

    // Initialize SQLite-specific settings
    await initializeSQLite();

    // Initialize model associations
    initializeAssociations();

    // Sync models in development
    if (process.env.NODE_ENV === 'development') {
      await sequelize.sync();
      console.log('Database models synchronized.');
    }

    // Create default user for SQLite
    await createDefaultUser();

    // Start periodic backups for SQLite
    const config = getDatabaseConfig();
    if (config.dialect === 'sqlite') {
      startPeriodicBackups();
    }
  } catch (error) {
    console.error('Unable to connect to the database:', error);
    throw error;
  }
};

// Close database connection
export const closeDatabase = async (): Promise<void> => {
  stopPeriodicBackups();
  await sequelize.close();
};

// Export backup functionality
export * from './backup';
export * from './scheduler';

