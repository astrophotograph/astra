import {Options} from 'sequelize'

export interface DatabaseConfig {
  dialect: 'postgres' | 'sqlite';
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  storage?: string; // For SQLite
  logging?: boolean | ((sql: string) => void);
  pool?: {
    max: number;
    min: number;
    acquire: number;
    idle: number;
  };
}

// Get database configuration based on environment
export const getDatabaseConfig = (): DatabaseConfig => {
  // console.log('DATABASE_TYPE:', process.env.DATABASE_TYPE)
  const dbType = process.env.DATABASE_TYPE as 'postgres' | 'sqlite' || 'postgres';

  if (dbType === 'postgres') {
    // For Neon or regular PostgreSQL
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is required for PostgreSQL');
    }

    // Parse DATABASE_URL if needed
    const url = new URL(databaseUrl);

    return {
      dialect: 'postgres',
      host: url.hostname,
      port: parseInt(url.port) || 5432,
      database: url.pathname.slice(1),
      username: url.username,
      password: url.password,
      logging: false,
      pool: {
        max: 10,
        min: 0,
        acquire: 30000,
        idle: 10000,
      },
    };
  }

  // SQLite configuration
  return {
    dialect: 'sqlite',
    storage: process.env.DATABASE_PATH || './database.sqlite',
    logging: false,
    pool: {
      max: 1,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
  };
};

// Create Sequelize options from config
export const createSequelizeOptions = (config: DatabaseConfig): Options => {
  if (config.dialect === 'postgres') {
    return {
      dialect: 'postgres',
      host: config.host,
      port: config.port,
      database: config.database!,
      username: config.username!,
      password: config.password!,
      logging: config.logging,
      pool: config.pool,
      dialectOptions: {
        ssl: process.env.NODE_ENV === 'production' ? {
          require: true,
          rejectUnauthorized: false
        } : false
      }
    };
  }

  return {
    dialect: 'sqlite',
    storage: config.storage!,
    logging: config.logging,
    pool: config.pool,
    dialectOptions: {
      // Enable foreign keys for SQLite
      // Note: This is handled differently in sqlite3
    },
    define: {
      // Global model options for SQLite
      underscored: true,
      freezeTableName: true,
    },
  };
};
