import {DataTypes, Model, Optional} from 'sequelize'
import {sequelize} from '../connection'

export interface ScheduleItem {
  id: string;
  objectName: string;
  startTime: string;
  duration: number; // in minutes
  ra: string;
  dec: string;
  magnitude: string;
  objectType?: string;
}

export interface ObservationScheduleAttributes {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  scheduled_date?: string; // YYYY-MM-DD format
  location?: string;
  items: ScheduleItem[]; // JSON array of schedule items
  is_active: boolean; // Whether this is the currently selected schedule
  created_at: Date;
  updated_at: Date;
}

export interface ObservationScheduleCreationAttributes extends Optional<ObservationScheduleAttributes, 'id' | 'created_at' | 'updated_at' | 'is_active'> {
  // Additional creation-specific attributes can be added here if needed
}

export class ObservationSchedule extends Model<ObservationScheduleAttributes, ObservationScheduleCreationAttributes> implements ObservationScheduleAttributes {
  declare id: string;
  declare user_id: string;
  declare name: string;
  declare description?: string;
  declare scheduled_date?: string;
  declare location?: string;
  declare items: ScheduleItem[];
  declare is_active: boolean;
  declare created_at: Date;
  declare updated_at: Date;
}

ObservationSchedule.init(
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    user_id: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    scheduled_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    location: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    items: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: '[]',
      get() {
        const value = this.getDataValue('items');
        return value ? JSON.parse(value) : [];
      },
      set(value: ScheduleItem[]) {
        this.setDataValue('items', JSON.stringify(value || []));
      },
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    modelName: 'ObservationSchedule',
    tableName: 'observation_schedules',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);