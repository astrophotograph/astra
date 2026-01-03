/**
 * Equipment Context - Manages equipment sets and provides reactive updates
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import {
  loadEquipment,
  saveEquipment,
  type EquipmentSet,
  type EquipmentState,
  generateEquipmentId,
} from "@/lib/astronomy-utils";

interface EquipmentContextValue {
  equipmentSets: EquipmentSet[];
  getEquipmentById: (id: string) => EquipmentSet | null;
  addEquipmentSet: (equipment: Omit<EquipmentSet, 'id'>) => EquipmentSet;
  updateEquipmentSet: (id: string, updates: Partial<Omit<EquipmentSet, 'id'>>) => void;
  deleteEquipmentSet: (id: string) => void;
  refreshEquipment: () => void;
}

const EquipmentContext = createContext<EquipmentContextValue | null>(null);

export function EquipmentProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EquipmentState>(() => loadEquipment());

  // Refresh from localStorage
  const refreshEquipment = useCallback(() => {
    setState(loadEquipment());
  }, []);

  // Get equipment by ID
  const getEquipmentById = useCallback((id: string): EquipmentSet | null => {
    return state.equipmentSets.find(eq => eq.id === id) || null;
  }, [state.equipmentSets]);

  // Add a new equipment set
  const addEquipmentSet = useCallback((equipment: Omit<EquipmentSet, 'id'>): EquipmentSet => {
    const newEquipment: EquipmentSet = {
      ...equipment,
      id: generateEquipmentId(),
    };

    setState(prev => {
      const newSets = [...prev.equipmentSets, newEquipment];
      const newState: EquipmentState = { equipmentSets: newSets };
      saveEquipment(newState);
      return newState;
    });

    return newEquipment;
  }, []);

  // Update an equipment set
  const updateEquipmentSet = useCallback((id: string, updates: Partial<Omit<EquipmentSet, 'id'>>) => {
    setState(prev => {
      const index = prev.equipmentSets.findIndex(eq => eq.id === id);
      if (index === -1) return prev;

      const newSets = [...prev.equipmentSets];
      newSets[index] = { ...newSets[index], ...updates };

      const newState: EquipmentState = { equipmentSets: newSets };
      saveEquipment(newState);
      return newState;
    });
  }, []);

  // Delete an equipment set
  const deleteEquipmentSet = useCallback((id: string) => {
    setState(prev => {
      const newSets = prev.equipmentSets.filter(eq => eq.id !== id);
      const newState: EquipmentState = { equipmentSets: newSets };
      saveEquipment(newState);
      return newState;
    });
  }, []);

  const value: EquipmentContextValue = {
    equipmentSets: state.equipmentSets,
    getEquipmentById,
    addEquipmentSet,
    updateEquipmentSet,
    deleteEquipmentSet,
    refreshEquipment,
  };

  return (
    <EquipmentContext.Provider value={value}>
      {children}
    </EquipmentContext.Provider>
  );
}

export function useEquipment() {
  const context = useContext(EquipmentContext);
  if (!context) {
    throw new Error("useEquipment must be used within an EquipmentProvider");
  }
  return context;
}
