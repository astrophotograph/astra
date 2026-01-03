/**
 * Location Context - Manages observer locations and provides reactive updates
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import {
  loadLocations,
  saveLocations,
  type ObserverLocation,
  type LocationsState,
  generateLocationId,
  parseHorizonFile,
  type HorizonProfile,
} from "@/lib/astronomy-utils";

interface LocationContextValue {
  locations: ObserverLocation[];
  activeLocation: ObserverLocation | null;
  activeLocationId: string | null;
  setActiveLocationId: (id: string) => void;
  addLocation: (location: Omit<ObserverLocation, 'id'>) => ObserverLocation;
  updateLocation: (id: string, updates: Partial<Omit<ObserverLocation, 'id'>>) => void;
  deleteLocation: (id: string) => void;
  updateLocationHorizon: (id: string, horizonText: string) => void;
  refreshLocations: () => void;
}

const LocationContext = createContext<LocationContextValue | null>(null);

export function LocationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LocationsState>(() => loadLocations());

  // Refresh from localStorage
  const refreshLocations = useCallback(() => {
    setState(loadLocations());
  }, []);

  // Get active location object
  const activeLocation = state.activeLocationId
    ? state.locations.find(loc => loc.id === state.activeLocationId) || null
    : null;

  // Set active location
  const setActiveLocationId = useCallback((id: string) => {
    setState(prev => {
      if (!prev.locations.some(loc => loc.id === id)) return prev;
      const newState = { ...prev, activeLocationId: id };
      saveLocations(newState);
      return newState;
    });
  }, []);

  // Add a new location
  const addLocation = useCallback((location: Omit<ObserverLocation, 'id'>): ObserverLocation => {
    const newLocation: ObserverLocation = {
      ...location,
      id: generateLocationId(),
    };

    setState(prev => {
      const newLocations = [...prev.locations, newLocation];
      const newState: LocationsState = {
        locations: newLocations,
        activeLocationId: newLocations.length === 1 ? newLocation.id : prev.activeLocationId,
      };
      saveLocations(newState);
      return newState;
    });

    return newLocation;
  }, []);

  // Update a location
  const updateLocation = useCallback((id: string, updates: Partial<Omit<ObserverLocation, 'id'>>) => {
    setState(prev => {
      const index = prev.locations.findIndex(loc => loc.id === id);
      if (index === -1) return prev;

      const newLocations = [...prev.locations];
      newLocations[index] = { ...newLocations[index], ...updates };

      const newState = { ...prev, locations: newLocations };
      saveLocations(newState);
      return newState;
    });
  }, []);

  // Delete a location
  const deleteLocation = useCallback((id: string) => {
    setState(prev => {
      const newLocations = prev.locations.filter(loc => loc.id !== id);
      const newActiveId = prev.activeLocationId === id
        ? (newLocations.length > 0 ? newLocations[0].id : null)
        : prev.activeLocationId;

      const newState: LocationsState = {
        locations: newLocations,
        activeLocationId: newActiveId,
      };
      saveLocations(newState);
      return newState;
    });
  }, []);

  // Update location horizon from text
  const updateLocationHorizon = useCallback((id: string, horizonText: string) => {
    const horizon: HorizonProfile | undefined = horizonText.trim()
      ? parseHorizonFile(horizonText)
      : undefined;

    updateLocation(id, { horizon });
  }, [updateLocation]);

  const value: LocationContextValue = {
    locations: state.locations,
    activeLocation,
    activeLocationId: state.activeLocationId,
    setActiveLocationId,
    addLocation,
    updateLocation,
    deleteLocation,
    updateLocationHorizon,
    refreshLocations,
  };

  return (
    <LocationContext.Provider value={value}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLocations() {
  const context = useContext(LocationContext);
  if (!context) {
    throw new Error("useLocations must be used within a LocationProvider");
  }
  return context;
}
