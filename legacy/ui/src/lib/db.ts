// Database utilities

import {AstronomyTodo, AstroObject, Collection, Image, Op, sequelize, User, withTransaction} from '@/lib/database'
import {
  AstroObject as AstroObjectType,
  Collection as CollectionType,
  CollectionSchema,
  Image as ImageType,
  ImageSchema,
  User as UserType,
} from "@/lib/models"
import {marked} from "marked"
import ObjectTypeMap from "@/lib/objectTypeMap"

// Add these new functions to db.ts
import {z} from "zod"
import {AstronomyObject} from "@/components/todo-list-types"
import {getImageDimensions} from "@/lib/image-processing"
import {readFile} from 'fs/promises'

// Update the AstronomyTodoSchema to include the flagged field
const AstronomyTodoSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  ra: z.string(),
  dec: z.string(),
  magnitude: z.string(),
  size: z.string(),
  objectType: z.string().nullish(),
  addedAt: z.string(),
  completed: z.boolean(),
  completedAt: z.string().nullish(),
  goalTime: z.string().nullish(),
  notes: z.string().nullish(),
  flagged: z.boolean().optional().default(false), // New field with default value
  last_updated: z.string().nullish(),
});

// Fetch all astronomy todo items for a user
export async function fetchAstronomyTodoItems(userId: string): Promise<AstronomyObject[]> {
  const todoItems = await AstronomyTodo.findAll({
    where: { user_id: userId },
    order: [['addedAt', 'DESC']],
  });

  return todoItems.map(item => ({
    id: item.id,
    name: item.name,
    ra: item.ra,
    dec: item.dec,
    magnitude: item.magnitude,
    size: item.size,
    objectType: item.objectType,
    addedAt: item.addedAt,
    completed: item.completed,
    completedAt: item.completedAt,
    goalTime: item.goalTime,
    notes: item.notes,
    flagged: item.flagged
  }));
}

// Create a new astronomy todo item
export async function createAstronomyTodoItem(
  userId: string,
  todoItem: AstronomyObject
): Promise<AstronomyObject> {
  const createdItem = await AstronomyTodo.create({
    id: todoItem.id,
    user_id: userId,
    name: todoItem.name,
    ra: todoItem.ra,
    dec: todoItem.dec,
    magnitude: todoItem.magnitude,
    size: todoItem.size,
    objectType: todoItem.objectType || null,
    addedAt: todoItem.addedAt,
    completed: todoItem.completed,
    completedAt: todoItem.completedAt || null,
    goalTime: todoItem.goalTime || null,
    notes: todoItem.notes || null,
    flagged: todoItem.flagged || false,
    last_updated: new Date().toISOString(),
  });

  return {
    id: createdItem.id,
    name: createdItem.name,
    ra: createdItem.ra,
    dec: createdItem.dec,
    magnitude: createdItem.magnitude,
    size: createdItem.size,
    objectType: createdItem.objectType,
    addedAt: createdItem.addedAt,
    completed: createdItem.completed,
    completedAt: createdItem.completedAt,
    goalTime: createdItem.goalTime,
    notes: createdItem.notes,
    flagged: createdItem.flagged
  };
}

export async function updateAstronomyTodoItem(
  userId: string,
  todoItem: AstronomyObject
): Promise<AstronomyObject> {
  const [affectedCount, updatedRows] = await AstronomyTodo.update(
    {
      name: todoItem.name,
      ra: todoItem.ra,
      dec: todoItem.dec,
      magnitude: todoItem.magnitude,
      size: todoItem.size,
      objectType: todoItem.objectType || null,
      completed: todoItem.completed,
      completedAt: todoItem.completedAt || null,
      goalTime: todoItem.goalTime || null,
      notes: todoItem.notes || null,
      flagged: todoItem.flagged || false,
      last_updated: new Date().toISOString(),
    },
    {
      where: { id: todoItem.id, user_id: userId },
      returning: true,
    }
  );

  if (affectedCount === 0) {
    throw new Error('Todo item not found or not authorized to update');
  }

  const updatedItem = updatedRows[0];
  return {
    id: updatedItem?.id ?? todoItem.id,
    name: todoItem.name,
    ra: todoItem.ra,
    dec: todoItem.dec,
    magnitude: todoItem.magnitude,
    size: todoItem.size,
    objectType: todoItem.objectType,
    addedAt: todoItem.addedAt,
    completed: todoItem.completed,
    completedAt: todoItem.completedAt,
    goalTime: todoItem.goalTime,
    notes: todoItem.notes,
    flagged: todoItem.flagged
  };
}

// Delete an astronomy todo item
export async function deleteAstronomyTodoItem(
  userId: string,
  itemId: string
): Promise<boolean> {
  const deletedCount = await AstronomyTodo.destroy({
    where: { id: itemId, user_id: userId },
  });

  return deletedCount > 0;
}

// Batch update or create multiple astronomy todo items
export async function syncAstronomyTodoItems(
  userId: string,
  todoItems: AstronomyObject[]
): Promise<AstronomyObject[]> {
  return await withTransaction(async (transaction) => {
    // First, get all existing items for this user
    const existingItems = await AstronomyTodo.findAll({
      where: { user_id: userId },
      attributes: ['id'],
      transaction,
    });

    const existingIds = new Set(existingItems.map(item => item.id));
    const results: AstronomyObject[] = [];

    // Process each item - update existing or create new
    for (const item of todoItems) {
      if (existingIds.has(item.id)) {
        // Item exists, update it
        const updatedItem = await updateAstronomyTodoItem(userId, item);
        results.push(updatedItem);
      } else {
        // Item is new, create it
        const newItem = await createAstronomyTodoItem(userId, item);
        results.push(newItem);
      }
    }

    // Delete items that are in the database but not in the provided list
    const currentIds = new Set(todoItems.map(item => item.id));
    const idsToDelete = Array.from(existingIds).filter(id => !currentIds.has(id));

    if (idsToDelete.length > 0) {
      await AstronomyTodo.destroy({
        where: {
          id: { [Op.in]: idsToDelete },
          user_id: userId,
        },
        transaction,
      });
    }

    return results;
  });
}


export async function fetchUser(id: string): Promise<UserType | null> {
  const user = await User.findByPk(id);
  // console.log('User:', user?.toJSON(), { id });
  return user ? user.toJSON() as UserType : null;
}

export async function fetchUserFromClerkUser(userId: string): Promise<UserType | null> {
  // For SQLite, we need to handle JSON differently
  const users = await User.findAll();
  const user = users.find(u => {
    const metadata = u.metadata_;
    return metadata && metadata['clerk:user_id'] === userId;
  });
  return user ? user.toJSON() as UserType : null;
}


export async function fetchCollections(user_id: string, visibility: string = 'public'): Promise<Array<CollectionType>> {
  const collections = await Collection.findAll({
    where: {
      user_id,
      visibility,
      [Op.or]: [
        { template: { [Op.ne]: 'astrolog' } },
        { template: { [Op.is]: null } },
      ],
    },
    order: [['created_at', 'DESC']],
  });

  return collections.map(c => c.toJSON()) as CollectionType[];
}

export async function fetchAstroObservations(user_id: string, visibility: string = 'public'): Promise<Array<CollectionType>> {
  const observations = await Collection.findAll({
    where: {
      user_id,
      visibility,
      template: 'astrolog',
    },
  });

  // Sort by session_date in JavaScript since SQLite JSON handling is different
  const sorted = observations.sort((a, b) => {
    const aDate = a.metadata_?.session_date || '';
    const bDate = b.metadata_?.session_date || '';
    return bDate.localeCompare(aDate);
  });

  return sorted.map(o => CollectionSchema.parse(o.toJSON())) as CollectionType[];
}

export async function fetchCatalogObjects(catalog: string): Promise<Array<AstroObjectType>> {
  const objects = await sequelize.query(
    `SELECT o.*
     FROM catalogobject ci 
     JOIN "object" o ON ci.object_id = o.id
     WHERE ci.catalog_id = :catalog
     ORDER BY o.seq`,
    {
      replacements: { catalog },
      type: sequelize.QueryTypes.SELECT,
    }
  );

  return objects as AstroObjectType[];
}

export async function fetchCollection(collection_id: string): Promise<CollectionType | null> {
  const collection = await Collection.findByPk(collection_id);
  return collection ? CollectionSchema.parse(collection.toJSON()) : null;
}

export async function fetchCollectionImages(collection_id: string): Promise<Array<ImageType>> {
  const collection = await Collection.findByPk(collection_id, {
    include: [{
      model: Image,
      as: 'images',
    }],
  });

  if (!collection?.images) return [];
  
  const imageDataList = collection.images.map(img => img.toJSON()) as ImageType[];
  
  // Ensure dimensions for all images
  for (const imageData of imageDataList) {
    await ensureImageDimensions(imageData);
  }
  
  return imageDataList.map(img => ImageSchema.parse(img));
}

export async function fetchCollectionImageCount(collection_id: string): Promise<number> {
  const result = await sequelize.query(
    `SELECT count(*) AS cnt
     FROM collectionimage 
     WHERE collection_id = :collection_id`,
    {
      replacements: { collection_id },
      type: sequelize.QueryTypes.SELECT,
    }
  );

  return (result[0] as any).cnt;
}

export async function fetchCollectionStats(collection_id: string) {
  // Placeholder for collection stats implementation
  return null;
}

export async function fetchImage(image_id: string): Promise<ImageType | null> {
  const image = await Image.findByPk(image_id);
  if (!image) return null;
  
  const imageData = image.toJSON() as ImageType;
  await ensureImageDimensions(imageData);
  return ImageSchema.parse(imageData);
}

export async function fetchUserImages(userId: string): Promise<Array<ImageType>> {
  const images = await Image.findAll({
    where: { user_id: userId },
    order: [['created_at', 'DESC']],
  });

  const imageDataList = images.map(img => img.toJSON()) as ImageType[];
  
  // Ensure dimensions for all images
  for (const imageData of imageDataList) {
    await ensureImageDimensions(imageData);
  }
  
  return imageDataList;
}

export async function fetchAstroObjectByName(name: string): Promise<AstroObjectType | null> {
  const astroObject = await AstroObject.findOne({
    where: { name },
  });
  // console.log('Astro object:', astroObject?.toJSON(), { name });
  return astroObject ? astroObject.toJSON() as AstroObjectType : null;
}

export async function fetchAstroObjects(): Promise<Array<AstroObjectType>> {
  const objects = await AstroObject.findAll({
    order: [['name', 'ASC']],
  });
  return objects.map(obj => obj.toJSON()) as AstroObjectType[];
}
//
// export async function fetchAstroObjectById(name: string): Promise<AstroObject | null> {
//   const sql = neon(`${process.env.DATABASE_URL}`)
//
//   const results = await sql`SELECT *
//                             FROM "object"
//                             WHERE id = ${name}
//                             LIMIT 1`
//   return results.length > 0 ? AstroObjectSchema.parse(results[0]) : null
// }
function formatLightYears(distance:number, multipler: number, prefix: string){
  const v = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 }).format(
    distance * multipler,
  );
  if (prefix !== '') {
    prefix += ' ';
  }
  return `${v} ${prefix}light years`
}

export function transformAstroObject(object: AstroObjectType){
  let title = `${object.display_name}`
  // @ts-ignore
  if (object.metadata_?.common_name) {
    title += ' - ' + object.metadata_.common_name
  }

  let distance = ''

  if (object.metadata_?.distance) {
    switch (object.metadata_?.distance_unit.trim()) {
      case 'Mpc':
        distance = formatLightYears(object.metadata_?.distance, 3.260, 'M');
        break
      case 'pc':
        distance = formatLightYears(object.metadata_?.distance, 3.260, '');
        break
      default:
        distance = formatLightYears(object.metadata_?.distance, 1.0, '')
    }
  }

  const object_type = ObjectTypeMap[object.otype || 'unknown'] || object.otype;

  // console.log(object)
  return {
    ...object,
    title,
    distance,
    object_type,
    common_name: object.metadata_?.common_name,
    // ra dec magnitudesize
    description: object.metadata_?.description,
    description_html: !!object.metadata_?.description ? marked.parse(object.metadata_?.description) : null,
  }

}

export async function ensureImageDimensions(imageData: ImageType): Promise<void> {
  // Check if dimensions are already in metadata
  if (imageData.metadata_?.width && imageData.metadata_?.height) {
    return;
  }

  try {
    // Try to read the image file and extract dimensions
    const buffer = await readFile(imageData.url);
    const dimensions = await getImageDimensions(buffer);
    
    if (dimensions) {
      // Update the database record with dimensions
      const updatedMetadata = {
        ...imageData.metadata_,
        width: dimensions.width,
        height: dimensions.height
      };
      
      await Image.update(
        { metadata_: updatedMetadata },
        { where: { id: imageData.id } }
      );
      
      // Update the in-memory object
      imageData.metadata_ = updatedMetadata;
    }
  } catch (error) {
    console.warn(`Could not update dimensions for image ${imageData.id}:`, error);
  }
}

export function getThumbnailUrl(imageData: ImageType, size: 500 | 1000): string | null {
  const thumbnailPath = size === 500 ? imageData.metadata_?.thumb500 : imageData.metadata_?.thumb1000;
  if (!thumbnailPath) return null;
  
  // Convert file path to URL path
  const filename = thumbnailPath.split('/').pop();
  return `/uploads/${imageData.user_id}/${filename}`;
}

export function getPlaceholderDataUrl(imageData: ImageType): string | null {
  return imageData.metadata_?.placeholder || null;
}

export async function fetchRecentTagsByUser(userId: string, limit: number = 20): Promise<string[]> {
  try {
    // Get all collections for the user that have tags
    const collections = await Collection.findAll({
      where: { 
        user_id: userId,
        tags: { [Op.ne]: null }
      },
      attributes: ['tags'],
      order: [['updated_at', 'DESC']],
      limit: 100 // Get recent collections
    });

    // Extract and flatten all tags
    const allTags = new Set<string>();
    collections.forEach(collection => {
      if (collection.tags) {
        const tags = collection.tags.split(',').map(tag => tag.trim()).filter(tag => tag);
        tags.forEach(tag => allTags.add(tag));
      }
    });

    // Return unique tags as array, limited to specified count
    return Array.from(allTags).slice(0, limit);
  } catch (error) {
    console.warn('Could not fetch recent tags:', error);
    return [];
  }
}
