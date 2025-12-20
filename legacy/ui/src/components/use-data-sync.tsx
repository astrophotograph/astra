"use client";

import {useCallback, useState} from "react"
import {toast} from "sonner"
import {AstronomyObject} from "@/components/todo-list-types"

// Safe localStorage helpers
const safeGetItem = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeSetItem = (key: string, value: string): void => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors
  }
};

export const useDataSync = (userId: string, initialData: AstronomyObject[]) => {
  const [objects, setObjects] = useState<AstronomyObject[]>(initialData);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);

  // Load data from API
  const fetchData = useCallback(async () => {
    if (!userId) return;

    setIsLoading(true);
    try {
      const response = await fetch('/api/astronomy-todo');
      if (!response.ok) {
        throw new Error('Failed to fetch astronomy todo items');
      }

      const data = await response.json();

      // Update localStorage for offline access
      safeSetItem('astronomyTodoObjects', JSON.stringify(data));

      setObjects(data);
      setLastSyncTime(new Date());

      return data;
    } catch (error) {
      console.error('Error fetching astronomy todo items:', error);
      toast.error('Failed to load your observation items. Using cached data.');

      // Fall back to localStorage if API fails
      const savedObjects = safeGetItem('astronomyTodoObjects');
      if (savedObjects) {
        setObjects(JSON.parse(savedObjects));
      }
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  // Sync data to API
  const syncData = useCallback(async (dataToSync: AstronomyObject[] = objects) => {
    if (!userId) return;

    setIsSyncing(true);
    try {
      const response = await fetch('/api/astronomy-todo', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ items: dataToSync }),
      });

      if (!response.ok) {
        throw new Error('Failed to sync astronomy todo items');
      }

      const synced = await response.json();

      // Update localStorage with synced data
      safeSetItem('astronomyTodoObjects', JSON.stringify(synced));

      setObjects(synced);
      setLastSyncTime(new Date());
      toast.success('Your observation list has been synced');

      return synced;
    } catch (error) {
      console.error('Error syncing astronomy todo items:', error);
      toast.error('Failed to sync your observation list. Changes saved locally.');

      // Keep using the local state as a fallback
      safeSetItem('astronomyTodoObjects', JSON.stringify(dataToSync));
    } finally {
      setIsSyncing(false);
    }
  }, [userId, objects]);

  // Add a new object
  const addObject = useCallback(async (newObject: AstronomyObject) => {
    if (!userId) {
      // Handle offline/unauthenticated case
      const updatedObjects = [...objects, newObject];
      setObjects(updatedObjects);
      safeSetItem('astronomyTodoObjects', JSON.stringify(updatedObjects));
      return newObject;
    }

    try {
      const response = await fetch('/api/astronomy-todo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(newObject),
      });

      if (!response.ok) {
        throw new Error('Failed to add astronomy todo item');
      }

      const createdObject = await response.json();

      // Update local state and storage
      const updatedObjects = [...objects, createdObject];
      setObjects(updatedObjects);
      safeSetItem('astronomyTodoObjects', JSON.stringify(updatedObjects));
      setLastSyncTime(new Date());

      return createdObject;
    } catch (error) {
      console.error('Error adding astronomy todo item:', error);
      toast.error('Failed to save to database. Object saved locally.');

      // Add to local state as fallback
      const updatedObjects = [...objects, newObject];
      setObjects(updatedObjects);
      safeSetItem('astronomyTodoObjects', JSON.stringify(updatedObjects));

      return newObject;
    }
  }, [userId, objects]);

  // Update an existing object
  const updateObject = useCallback(async (updatedObject: AstronomyObject) => {
    // Update local state immediately for responsive UI
    const updatedObjects = objects.map(obj =>
      obj.id === updatedObject.id ? updatedObject : obj
    );
    setObjects(updatedObjects);
    safeSetItem('astronomyTodoObjects', JSON.stringify(updatedObjects));

    if (!userId) return updatedObject;

    try {
      const response = await fetch('/api/astronomy-todo', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatedObject),
      });

      if (!response.ok) {
        throw new Error('Failed to update astronomy todo item');
      }

      const result = await response.json();
      setLastSyncTime(new Date());

      return result;
    } catch (error) {
      console.error('Error updating astronomy todo item:', error);
      toast.error('Failed to update in database. Changes saved locally.');
      return updatedObject;
    }
  }, [userId, objects]);

  // Delete an object
  const deleteObject = useCallback(async (id: string) => {
    // Update local state immediately for responsive UI
    const updatedObjects = objects.filter(obj => obj.id !== id);
    setObjects(updatedObjects);
    safeSetItem('astronomyTodoObjects', JSON.stringify(updatedObjects));

    if (!userId) return true;

    try {
      const response = await fetch(`/api/astronomy-todo?id=${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete astronomy todo item');
      }

      setLastSyncTime(new Date());
      return true;
    } catch (error) {
      console.error('Error deleting astronomy todo item:', error);
      toast.error('Failed to delete from database. Removed locally.');
      return false;
    }
  }, [userId, objects]);

  // Import objects (used by the import functionality)
  const importObjects = useCallback(async (importedObjects: AstronomyObject[], mode: "replace" | "merge") => {
    let newObjects: AstronomyObject[];

    if (mode === "replace") {
      // Replace all existing objects
      newObjects = [...importedObjects];
    } else {
      // Merge with existing objects (avoid duplicates by name)
      const existingNames = new Set(objects.map(obj => obj.name.toLowerCase()));
      const uniqueImported = importedObjects.filter(obj => !existingNames.has(obj.name.toLowerCase()));
      newObjects = [...objects, ...uniqueImported];
    }

    // Update local state and storage
    setObjects(newObjects);
    safeSetItem('astronomyTodoObjects', JSON.stringify(newObjects));

    // If user is authenticated, sync with server
    if (userId) {
      return await syncData(newObjects);
    }

    return newObjects;
  }, [userId, objects, syncData]);

  return {
    objects,
    setObjects,
    isLoading,
    isSyncing,
    lastSyncTime,
    fetchData,
    syncData,
    addObject,
    updateObject,
    deleteObject,
    importObjects
  };
};
