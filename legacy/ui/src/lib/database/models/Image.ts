import {DataTypes, Model, Optional} from 'sequelize'
import {sequelize} from '../connection'
import {User} from './User'

export interface ImageAttributes {
  id: string;
  user_id: string;
  filename: string;
  url?: string;
  summary?: string;
  description?: string;
  content_type?: string;
  favorite?: boolean;
  tags?: string;
  visibility?: string;
  location?: string;
  annotations?: Record<string, any>[];
  metadata_?: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface ImageCreationAttributes
  extends Optional<ImageAttributes, 'id' | 'created_at' | 'updated_at'> {}

export class Image extends Model<ImageAttributes, ImageCreationAttributes>
  implements ImageAttributes {
  public id!: string;
  public user_id!: string;
  public filename!: string;
  public url?: string;
  public summary?: string;
  public description?: string;
  public content_type?: string;
  public favorite?: boolean;
  public tags?: string;
  public visibility?: string;
  public location?: string;
  public annotations?: Record<string, any>[];
  public metadata_?: Record<string, any>;
  public created_at!: Date;
  public updated_at!: Date;
}

Image.init(
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
        model: User,
        key: 'id',
      },
    },
    filename: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    url: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    summary: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    content_type: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'image/jpeg',
    },
    favorite: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    },
    tags: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    visibility: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'private',
    },
    location: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    annotations: {
      type: DataTypes.TEXT,
      allowNull: true,
      get() {
        const value = this.getDataValue('annotations');
        return value ? JSON.parse(value) : [];
      },
      set(value: any) {
        this.setDataValue('annotations', value ? JSON.stringify(value) : null);
      },
    },
    metadata_: {
      type: DataTypes.TEXT,
      allowNull: true,
      get() {
        const value = this.getDataValue('metadata_');
        return value ? JSON.parse(value) : null;
      },
      set(value: any) {
        this.setDataValue('metadata_', value ? JSON.stringify(value) : null);
      },
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
    modelName: 'Image',
    tableName: 'images',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        fields: ['user_id'],
      },
      {
        fields: ['filename'],
      },
    ],
  }
);

