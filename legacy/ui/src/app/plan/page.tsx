"use client";

import {useState, useEffect} from "react"
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card"
import {Button} from "@/components/ui/button"
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger} from "@/components/ui/dialog"
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger} from "@/components/ui/dropdown-menu"
import {Input} from "@/components/ui/input"
import {Label} from "@/components/ui/label"
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select"
import {Tabs, TabsContent, TabsList, TabsTrigger} from "@/components/ui/tabs"
import {Textarea} from "@/components/ui/textarea"
import {WeatherConditions} from "@/components/WeatherConditions"
import {MoonPhase} from "@/components/MoonPhase"
import {ObjectAltitudeDialog} from "@/components/object-altitude-dialog"
import {StarMap} from "@/components/StarMap"
import {AladinLite} from "@/components/AladinLite"
import {EditScheduleItemDialog} from "@/components/edit-schedule-item-dialog"
import {Calendar, ChevronDown, ChevronLeft, ChevronRight, Clock, Edit, Info, Map, MapPin, MoreVertical, Plus, Search, Telescope, Trash2} from "lucide-react"
import {toast} from "sonner"
import {AstroObject, User} from "@/lib/models"
import {DefaultBreadcrumb} from "@/components/default-breadcrumb"
import {useAuth} from "@/hooks/useAuth"
import {parseCoordinates, calculateAltitudeAtTime, calculateCurrentAzimuth, azimuthToCompassDirection, generateNightAltitudeData, formatTime as formatAstroTime} from "@/lib/astronomy-utils"
import Script from 'next/script'

interface PlanningItem {
  id: string;
  objectName: string;
  startTime: string;
  duration: number; // in minutes
  ra: string;
  dec: string;
  magnitude: string;
  objectType?: string;
}

interface ObservationSchedule {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  scheduled_date?: string;
  location?: string;
  items: PlanningItem[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export default function PlanPage() {
  const [isLoaded, setIsLoaded] = useState(false);
  const [astroObjects, setAstroObjects] = useState<AstroObject[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedObject, setSelectedObject] = useState<AstroObject | null>(null);
  const [schedules, setSchedules] = useState<ObservationSchedule[]>([]);
  const [activeSchedule, setActiveSchedule] = useState<ObservationSchedule | null>(null);
  const [newItemStartTime, setNewItemStartTime] = useState("");
  const [newItemDuration, setNewItemDuration] = useState(30);
  const [showAltitudeDialog, setShowAltitudeDialog] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [userLocation, setUserLocation] = useState<{latitude: number; longitude: number; city?: string} | null>(null);
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [objectFilter, setObjectFilter] = useState<string>("all");
  const [showNewScheduleDialog, setShowNewScheduleDialog] = useState(false);
  const [newScheduleName, setNewScheduleName] = useState("");
  const [newScheduleDescription, setNewScheduleDescription] = useState("");
  const [showAddToScheduleDialog, setShowAddToScheduleDialog] = useState(false);
  const [selectedRecommendation, setSelectedRecommendation] = useState<{
    id: string;
    name: string;
    display_name?: string;
    type: string;
    otype?: string;
    magnitude: number;
    description: string;
    altitude: number;
    azimuth: number;
    direction: string;
    ra?: string;
    dec?: string;
    metadata_?: {
      ra?: string;
      dec?: string;
      magnitude?: string;
    };
  } | null>(null);
  const [quickAddStartTime, setQuickAddStartTime] = useState("");
  const [quickAddDuration, setQuickAddDuration] = useState(30);
  const [showEditItemDialog, setShowEditItemDialog] = useState(false);
  const [editingItem, setEditingItem] = useState<PlanningItem | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const { user: clerkUser, isSQLiteMode } = useAuth();

  const user: User | null = isSQLiteMode ? {
    id: 'sqlite-default-user',
    username: 'Default User',
    first_name: 'Default',
    last_name: 'User',
    name: 'Default User',
    initials: 'DU',
    avatar_url: '',
    metadata_: {},
    email: 'user@example.com',
  } : clerkUser ? {
    id: clerkUser.id,
    username: clerkUser.username || '',
    first_name: clerkUser.firstName || '',
    last_name: clerkUser.lastName || '',
    name: clerkUser.fullName || clerkUser.username || '',
    initials: `${clerkUser.firstName?.[0] || ''}${clerkUser.lastName?.[0] || ''}`,
    avatar_url: clerkUser.imageUrl || '',
    metadata_: {},
    email: clerkUser.primaryEmailAddress?.emailAddress || '',
  } : null;

  // Get user's location
  const getUserLocation = async () => {
    if (!navigator.geolocation) {
      setLocationError("Geolocation is not supported by this browser");
      return;
    }

    setLocationLoading(true);
    setLocationError(null);

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;

        try {
          // Try to get city name from coordinates using a reverse geocoding API
          // Using a simple approach for now, you can enhance this with a proper geocoding service
          const response = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`);
          const data = await response.json();
          const city = data.city || data.locality || `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`;

          setUserLocation({ latitude, longitude, city });
          toast.success(`Location set to ${city}`);
        } catch {
          // If geocoding fails, just use coordinates
          setUserLocation({ latitude, longitude, city: `${latitude.toFixed(2)}, ${longitude.toFixed(2)}` });
          toast.success("Location obtained");
        }

        setLocationLoading(false);
      },
      (error) => {
        let message = "Unable to get location";
        switch (error.code) {
          case error.PERMISSION_DENIED:
            message = "Location access denied by user";
            break;
          case error.POSITION_UNAVAILABLE:
            message = "Location information unavailable";
            break;
          case error.TIMEOUT:
            message = "Location request timed out";
            break;
        }
        setLocationError(message);
        setLocationLoading(false);
        toast.error(message);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 300000 // 5 minutes
      }
    );
  };

  // Load schedules
  const loadSchedules = async () => {
    try {
      const response = await fetch('/api/schedules');
      if (response.ok) {
        const scheduleData = await response.json();
        setSchedules(scheduleData);

        // Find and set active schedule
        const active = scheduleData.find((s: ObservationSchedule) => s.is_active);
        setActiveSchedule(active || null);
      }
    } catch (error) {
      console.error('Error loading schedules:', error);
      toast.error('Failed to load schedules');
    }
  };

  // Create new schedule
  const createNewSchedule = async () => {
    if (!newScheduleName.trim()) {
      toast.error('Please enter a schedule name');
      return;
    }

    try {
      const response = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newScheduleName.trim(),
          description: newScheduleDescription.trim() || undefined,
          location: userLocation?.city
        })
      });

      if (response.ok) {
        const newSchedule = await response.json();
        setSchedules(prev => [newSchedule, ...prev]);
        setActiveSchedule(newSchedule);
        setNewScheduleName("");
        setNewScheduleDescription("");
        setShowNewScheduleDialog(false);
        toast.success(`Schedule "${newSchedule.name}" created`);
      } else {
        toast.error('Failed to create schedule');
      }
    } catch (error) {
      console.error('Error creating schedule:', error);
      toast.error('Failed to create schedule');
    }
  };

  // Switch active schedule
  const switchSchedule = async (schedule: ObservationSchedule) => {
    try {
      const response = await fetch('/api/schedules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: schedule.id,
          is_active: true
        })
      });

      if (response.ok) {
        const updatedSchedule = await response.json();
        setActiveSchedule(updatedSchedule);

        // Update schedules list
        setSchedules(prev => prev.map(s => ({
          ...s,
          is_active: s.id === schedule.id
        })));

        toast.success(`Switched to "${schedule.name}"`);
      }
    } catch (error) {
      console.error('Error switching schedule:', error);
      toast.error('Failed to switch schedule');
    }
  };

  // Delete schedule
  const deleteSchedule = async (schedule: ObservationSchedule) => {
    if (schedules.length === 1) {
      toast.error('Cannot delete the last schedule');
      return;
    }

    try {
      const response = await fetch(`/api/schedules?id=${schedule.id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        setSchedules(prev => prev.filter(s => s.id !== schedule.id));

        if (schedule.is_active) {
          // Switch to the next available schedule
          const remaining = schedules.filter(s => s.id !== schedule.id);
          if (remaining.length > 0) {
            await switchSchedule(remaining[0]);
          }
        }

        toast.success(`Schedule "${schedule.name}" deleted`);
      }
    } catch (error) {
      console.error('Error deleting schedule:', error);
      toast.error('Failed to delete schedule');
    }
  };

  // Update schedule items
  const updateScheduleItems = async (items: PlanningItem[]) => {
    if (!activeSchedule) return;

    try {
      const response = await fetch('/api/schedules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: activeSchedule.id,
          items
        })
      });

      if (response.ok) {
        const updatedSchedule = await response.json();
        setActiveSchedule(updatedSchedule);

        // Update in schedules list
        setSchedules(prev => prev.map(s =>
          s.id === updatedSchedule.id ? updatedSchedule : s
        ));
      }
    } catch (error) {
      console.error('Error updating schedule:', error);
      toast.error('Failed to update schedule');
    }
  };

  // Load user location and schedules on component mount
  useEffect(() => {
    getUserLocation();
    loadSchedules();
  }, []);

  const loadAstroObjects = async (query: string) => {
    if (!query) {
      setAstroObjects([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const response = await fetch(`/api/lookup-astronomy-object?name=${encodeURIComponent(query)}`);
      if (!response.ok) {
        throw new Error('Failed to fetch objects');
      }
      const objects = await response.json();
      setAstroObjects(objects.map((obj: {
        name: string;
        objectType: string;
        ra: string;
        dec: string;
        magnitude: string;
      }) => ({
        ...obj,
        id: obj.name,
        display_name: obj.name,
        otype: obj.objectType,
        metadata_: {
          ra: obj.ra,
          dec: obj.dec,
          magnitude: obj.magnitude,
        }
      })));
    } catch (error) {
      console.error('Error loading astronomical objects:', error);
      toast.error('Failed to load astronomical objects');
    } finally {
      setIsLoading(false);
    }
  };

  // No need for filtering, API does it
  const filteredObjects = astroObjects;

  const addToSchedule = async () => {
    if (!selectedObject || !newItemStartTime) {
      toast.error('Please select an object and set a start time');
      return;
    }

    if (!activeSchedule) {
      toast.error('No active schedule. Please create a schedule first.');
      return;
    }

    const newItem: PlanningItem = {
      id: crypto.randomUUID(),
      objectName: selectedObject.display_name || selectedObject.name,
      startTime: newItemStartTime,
      duration: newItemDuration,
      ra: selectedObject.metadata_?.ra || '0',
      dec: selectedObject.metadata_?.dec || '0',
      magnitude: selectedObject.metadata_?.magnitude || 'N/A',
      objectType: selectedObject.otype || undefined
    };

    const updatedItems = [...activeSchedule.items, newItem].sort((a, b) => a.startTime.localeCompare(b.startTime));
    await updateScheduleItems(updatedItems);
    setNewItemStartTime("");
    toast.success(`Added ${newItem.objectName} to schedule`);
  };

  const removeFromSchedule = async (id: string) => {
    if (!activeSchedule) return;

    const updatedItems = activeSchedule.items.filter(item => item.id !== id);
    await updateScheduleItems(updatedItems);
    toast.success('Removed from schedule');
  };

  // Edit schedule item
  const editScheduleItem = (item: PlanningItem) => {
    setEditingItem(item);
    setShowEditItemDialog(true);
  };

  const saveEditedItem = async (updatedItem: PlanningItem) => {
    if (!activeSchedule) return;

    const updatedItems = activeSchedule.items.map(item =>
      item.id === updatedItem.id ? updatedItem : item
    ).sort((a, b) => a.startTime.localeCompare(b.startTime));

    await updateScheduleItems(updatedItems);
    toast.success('Schedule item updated');
  };

  // Add recommendation to schedule
  const addRecommendationToSchedule = async () => {
    if (!selectedRecommendation || !quickAddStartTime) {
      toast.error('Please set a start time');
      return;
    }

    if (!activeSchedule) {
      toast.error('No active schedule. Please create a schedule first.');
      return;
    }

    const newItem: PlanningItem = {
      id: crypto.randomUUID(),
      objectName: selectedRecommendation.display_name || selectedRecommendation.name,
      startTime: quickAddStartTime,
      duration: quickAddDuration,
      ra: selectedRecommendation.metadata_?.ra || selectedRecommendation.ra || '0',
      dec: selectedRecommendation.metadata_?.dec || selectedRecommendation.dec || '0',
      magnitude: selectedRecommendation.metadata_?.magnitude || selectedRecommendation.magnitude?.toString() || 'N/A',
      objectType: selectedRecommendation.otype || selectedRecommendation.type || undefined
    };

    const updatedItems = [...activeSchedule.items, newItem].sort((a, b) => a.startTime.localeCompare(b.startTime));
    await updateScheduleItems(updatedItems);

    // Reset dialog state
    setShowAddToScheduleDialog(false);
    setSelectedRecommendation(null);
    setQuickAddStartTime("");
    setQuickAddDuration(30);

    toast.success(`Added ${newItem.objectName} to ${activeSchedule.name}`);
  };

  // Handle clicking on a recommendation
  const handleRecommendationClick = (recommendation: typeof selectedRecommendation) => {
    setSelectedRecommendation(recommendation);

    // Set a suggested start time (current time + 1 hour, rounded to nearest 15 minutes)
    const now = new Date();
    now.setHours(now.getHours() + 1);
    const minutes = Math.ceil(now.getMinutes() / 15) * 15;
    now.setMinutes(minutes, 0, 0);
    const timeString = now.toTimeString().slice(0, 5);
    setQuickAddStartTime(timeString);

    setShowAddToScheduleDialog(true);
  };

  // Get schedule conflicts for time visualization
  const getScheduleConflicts = (startTime: string, duration: number) => {
    if (!activeSchedule || !startTime) return [];

    const conflicts: PlanningItem[] = [];
    const newEndTime = calculateEndTime(startTime, duration);

    activeSchedule.items.forEach(item => {
      const itemEndTime = calculateEndTime(item.startTime, item.duration);

      // Check for time overlap
      if (
        (startTime >= item.startTime && startTime < itemEndTime) ||
        (newEndTime > item.startTime && newEndTime <= itemEndTime) ||
        (startTime <= item.startTime && newEndTime >= itemEndTime)
      ) {
        conflicts.push(item);
      }
    });

    return conflicts;
  };

  // Generate altitude data for the selected recommendation
  const getRecommendationAltitudeData = () => {
    if (!selectedRecommendation || !userLocation) return [];

    const coords = parseCoordinates(
      selectedRecommendation.metadata_?.ra || selectedRecommendation.ra || '0h 0m 0s',
      selectedRecommendation.metadata_?.dec || selectedRecommendation.dec || '+0° 0\' 0"'
    );

    if (!coords) return [];

    return generateNightAltitudeData(coords.raDeg, coords.decDeg, userLocation);
  };

  const getRecommendedObjects = () => {
    // Get current time and use user's location or fallback to NYC
    const now = new Date();
    const coordinates = userLocation || { latitude: 40.7128, longitude: -74.0060 };

    // Expanded list of bright, interesting objects categorized by type
    const brightObjects = [
      // Planets (positions are approximate and would need real-time ephemeris for accuracy)
      { name: "Jupiter", magnitude: -2.5, type: "Planet", ra: "2h 30m 0s", dec: "+15° 0' 0\"", description: "Largest planet, shows bands and moons" },
      { name: "Saturn", magnitude: 0.7, type: "Planet", ra: "21h 45m 0s", dec: "-18° 0' 0\"", description: "Beautiful rings visible in telescope" },
      { name: "Mars", magnitude: -1.8, type: "Planet", ra: "5h 15m 0s", dec: "+25° 0' 0\"", description: "Red planet, shows polar caps" },
      { name: "Venus", magnitude: -4.2, type: "Planet", ra: "18h 0m 0s", dec: "-23° 0' 0\"", description: "Brightest planet, shows phases" },

      // Bright Stars
      { name: "Sirius", magnitude: -1.46, type: "Star", ra: "6h 45m 9s", dec: "-16° 42' 58\"", description: "Brightest star in the night sky" },
      { name: "Arcturus", magnitude: -0.05, type: "Star", ra: "14h 15m 40s", dec: "+19° 10' 57\"", description: "Orange giant in Boötes" },
      { name: "Vega", magnitude: 0.03, type: "Star", ra: "18h 36m 56s", dec: "+38° 47' 1\"", description: "Blue-white star in Lyra" },
      { name: "Capella", magnitude: 0.08, type: "Star", ra: "5h 16m 41s", dec: "+45° 59' 53\"", description: "Golden star in Auriga" },
      { name: "Rigel", magnitude: 0.13, type: "Star", ra: "5h 14m 32s", dec: "-8° 12' 6\"", description: "Blue supergiant in Orion" },
      { name: "Procyon", magnitude: 0.34, type: "Star", ra: "7h 39m 18s", dec: "+5° 13' 30\"", description: "White star in Canis Minor" },
      { name: "Betelgeuse", magnitude: 0.50, type: "Star", ra: "5h 55m 10s", dec: "+7° 24' 25\"", description: "Red supergiant in Orion" },
      { name: "Aldebaran", magnitude: 0.85, type: "Star", ra: "4h 35m 55s", dec: "+16° 30' 33\"", description: "Orange giant in Taurus" },

      // Double Stars
      { name: "Albireo", magnitude: 3.1, type: "Double Star", ra: "19h 30m 43s", dec: "+27° 57' 35\"", description: "Beautiful gold and blue double star" },
      { name: "Mizar & Alcor", magnitude: 2.3, type: "Double Star", ra: "13h 23m 56s", dec: "+54° 55' 31\"", description: "Famous double star in Big Dipper" },
      { name: "Castor", magnitude: 1.57, type: "Double Star", ra: "7h 34m 36s", dec: "+31° 53' 18\"", description: "Multiple star system in Gemini" },
      { name: "Almach", magnitude: 2.26, type: "Double Star", ra: "2h 3m 54s", dec: "+42° 19' 47\"", description: "Orange and blue double in Andromeda" },

      // Open Clusters
      { name: "M45 (Pleiades)", magnitude: 1.6, type: "Open Cluster", ra: "3h 47m 0s", dec: "+24° 7' 0\"", description: "Seven Sisters star cluster" },
      { name: "M44 (Beehive Cluster)", magnitude: 3.7, type: "Open Cluster", ra: "8h 40m 6s", dec: "+19° 59' 0\"", description: "Bright cluster in Cancer" },
      { name: "Double Cluster", magnitude: 4.3, type: "Open Cluster", ra: "2h 20m 0s", dec: "+57° 8' 0\"", description: "Two beautiful clusters together" },
      { name: "M35", magnitude: 5.3, type: "Open Cluster", ra: "6h 8m 54s", dec: "+24° 20' 0\"", description: "Rich cluster in Gemini" },
      { name: "M37", magnitude: 6.2, type: "Open Cluster", ra: "5h 52m 18s", dec: "+32° 33' 12\"", description: "Richest cluster in Auriga" },
      { name: "M36", magnitude: 6.3, type: "Open Cluster", ra: "5h 36m 6s", dec: "+34° 8' 24\"", description: "Cross-shaped cluster in Auriga" },
      { name: "M38", magnitude: 7.4, type: "Open Cluster", ra: "5h 28m 42s", dec: "+35° 50' 0\"", description: "Starfish cluster in Auriga" },
      { name: "M67", magnitude: 6.1, type: "Open Cluster", ra: "8h 50m 24s", dec: "+11° 49' 0\"", description: "Ancient cluster in Cancer" },

      // Globular Clusters
      { name: "M13 (Hercules Cluster)", magnitude: 5.8, type: "Globular Cluster", ra: "16h 41m 41s", dec: "+36° 27' 37\"", description: "Spectacular globular cluster" },
      { name: "M92", magnitude: 6.3, type: "Globular Cluster", ra: "17h 17m 7s", dec: "+43° 8' 11\"", description: "Another fine globular in Hercules" },
      { name: "M3", magnitude: 6.2, type: "Globular Cluster", ra: "13h 42m 11s", dec: "+28° 22' 38\"", description: "Beautiful globular in Canes Venatici" },
      { name: "M5", magnitude: 5.6, type: "Globular Cluster", ra: "15h 18m 33s", dec: "+2° 4' 58\"", description: "Bright globular in Serpens" },
      { name: "M4", magnitude: 5.6, type: "Globular Cluster", ra: "16h 23m 35s", dec: "-26° 31' 33\"", description: "Loose globular near Antares" },
      { name: "M22", magnitude: 5.1, type: "Globular Cluster", ra: "18h 36m 24s", dec: "-23° 54' 17\"", description: "Bright southern globular" },

      // Galaxies
      { name: "M31 (Andromeda Galaxy)", magnitude: 3.4, type: "Galaxy", ra: "0h 42m 44s", dec: "+41° 16' 9\"", description: "Nearest major galaxy" },
      { name: "M32", magnitude: 8.1, type: "Galaxy", ra: "0h 42m 42s", dec: "+40° 52' 0\"", description: "Companion to Andromeda" },
      { name: "M110", magnitude: 8.5, type: "Galaxy", ra: "0h 40m 22s", dec: "+41° 41' 7\"", description: "Another Andromeda companion" },
      { name: "M81 (Bode's Galaxy)", magnitude: 6.9, type: "Galaxy", ra: "9h 55m 33s", dec: "+69° 3' 55\"", description: "Bright spiral galaxy" },
      { name: "M82 (Cigar Galaxy)", magnitude: 8.4, type: "Galaxy", ra: "9h 55m 52s", dec: "+69° 40' 47\"", description: "Starburst galaxy near M81" },
      { name: "M51 (Whirlpool Galaxy)", magnitude: 8.4, type: "Galaxy", ra: "13h 29m 53s", dec: "+47° 11' 43\"", description: "Face-on spiral with companion" },
      { name: "M101 (Pinwheel Galaxy)", magnitude: 7.9, type: "Galaxy", ra: "14h 3m 13s", dec: "+54° 20' 57\"", description: "Large face-on spiral" },
      { name: "M104 (Sombrero Galaxy)", magnitude: 8.0, type: "Galaxy", ra: "12h 39m 59s", dec: "-11° 37' 23\"", description: "Edge-on galaxy with dark lane" },

      // Nebulae
      { name: "M42 (Orion Nebula)", magnitude: 4.0, type: "Nebula", ra: "5h 35m 17s", dec: "-5° 23' 14\"", description: "Stellar nursery in Orion" },
      { name: "M43", magnitude: 9.0, type: "Nebula", ra: "5h 35m 31s", dec: "-5° 16' 3\"", description: "Part of Orion Nebula complex" },
      { name: "M57 (Ring Nebula)", magnitude: 8.8, type: "Planetary Nebula", ra: "18h 53m 36s", dec: "+33° 1' 45\"", description: "Famous ring-shaped nebula" },
      { name: "M27 (Dumbbell Nebula)", magnitude: 7.5, type: "Planetary Nebula", ra: "19h 59m 36s", dec: "+22° 43' 16\"", description: "Apple-core shaped nebula" },
      { name: "M76 (Little Dumbbell)", magnitude: 10.1, type: "Planetary Nebula", ra: "1h 42m 20s", dec: "+51° 34' 31\"", description: "Planetary nebula in Perseus" },
      { name: "M97 (Owl Nebula)", magnitude: 9.9, type: "Planetary Nebula", ra: "11h 14m 48s", dec: "+55° 1' 8\"", description: "Owl-faced planetary nebula" },
      { name: "NGC 7000 (North America)", magnitude: 4.0, type: "Nebula", ra: "20h 58m 48s", dec: "+44° 12' 0\"", description: "Large emission nebula" },
      { name: "M8 (Lagoon Nebula)", magnitude: 6.0, type: "Nebula", ra: "18h 3m 48s", dec: "-24° 23' 12\"", description: "Bright nebula in Sagittarius" },
      { name: "M20 (Trifid Nebula)", magnitude: 9.0, type: "Nebula", ra: "18h 2m 6s", dec: "-23° 2' 0\"", description: "Three-part nebula near Lagoon" },
      { name: "M16 (Eagle Nebula)", magnitude: 6.4, type: "Nebula", ra: "18h 18m 48s", dec: "-13° 49' 0\"", description: "Home of Pillars of Creation" },
      { name: "M17 (Swan Nebula)", magnitude: 7.0, type: "Nebula", ra: "18h 20m 48s", dec: "-16° 11' 0\"", description: "Swan-shaped emission nebula" }
    ];

    // Filter for currently visible objects and sort by observability
    const currentlyVisible = brightObjects.filter(obj => {
      // Parse coordinates
      const coords = parseCoordinates(obj.ra, obj.dec);
      if (!coords) return false;

      // Calculate current altitude
      const altitude = calculateAltitudeAtTime(coords.raDeg, coords.decDeg, coordinates, now);

      // Object is visible if it's at least 20 degrees above horizon
      return altitude > 20;
    }).map(obj => {
      const coords = parseCoordinates(obj.ra, obj.dec);
      const altitude = coords ? calculateAltitudeAtTime(coords.raDeg, coords.decDeg, coordinates, now) : 0;
      const azimuth = coords ? calculateCurrentAzimuth(coords.raDeg, coords.decDeg, coordinates) : 0;
      const direction = azimuthToCompassDirection(azimuth);

      return {
        ...obj,
        altitude: Math.round(altitude),
        azimuth: Math.round(azimuth),
        direction,
        id: obj.name,
        display_name: obj.name,
        otype: obj.type,
        metadata_: {
          ra: obj.ra,
          dec: obj.dec,
          magnitude: obj.magnitude.toString(),
          altitude: altitude.toString(),
          azimuth: azimuth.toString(),
          direction
        }
      };
    }).sort((a, b) => {
      // Sort by altitude (higher is better) then by magnitude (brighter is better)
      if (b.altitude !== a.altitude) {
        return b.altitude - a.altitude;
      }
      return a.magnitude - b.magnitude;
    });

    // Apply object type filter
    let filteredObjects = currentlyVisible;
    if (objectFilter !== "all") {
      filteredObjects = currentlyVisible.filter(obj =>
        obj.type.toLowerCase().replace(/\s+/g, '-') === objectFilter
      );
    }

    return filteredObjects.slice(0, 12);
  };

  const formatTime = (timeString: string) => {
    if (!timeString) return '';
    const [hours, minutes] = timeString.split(':');
    return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
  };

  const calculateEndTime = (startTime: string, duration: number) => {
    if (!startTime) return '';
    const [hours, minutes] = startTime.split(':').map(Number);
    const endMinutes = minutes + duration;
    const endHours = hours + Math.floor(endMinutes / 60);
    const finalMinutes = endMinutes % 60;
    return `${(endHours % 24).toString().padStart(2, '0')}:${finalMinutes.toString().padStart(2, '0')}`;
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <Script src={"https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js"}
              onLoad={() => {setIsLoaded(true)}}
      />
      <DefaultBreadcrumb user={user || undefined} pageName="Plan" />
      <div className="flex items-center gap-3 mb-8">
        <Telescope className="w-8 h-8 text-blue-400" />
        <h1 className="text-3xl font-bold">Astronomy Planning</h1>
      </div>

      <div className={`grid gap-6 transition-all duration-300 ${sidebarCollapsed ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-4'}`}>
        {/* Main Content */}
        <div className={`${sidebarCollapsed ? 'col-span-1' : 'lg:col-span-3'}`}>
          <Tabs defaultValue="lookup" className="w-full">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="lookup" className="flex items-center gap-2">
                <Search className="w-4 h-4" />
                Object Lookup
              </TabsTrigger>
              <TabsTrigger value="recommendations" className="flex items-center gap-2">
                <Telescope className="w-4 h-4" />
                Recommendations
              </TabsTrigger>
              <TabsTrigger value="schedule" className="flex items-center gap-2">
                <Calendar className="w-4 h-4" />
                Schedule
              </TabsTrigger>
              <TabsTrigger value="skymap" className="flex items-center gap-2">
                <Map className="w-4 h-4" />
                Sky Map
              </TabsTrigger>
            </TabsList>

            <TabsContent value="lookup" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Search className="w-5 h-5" />
                    Astronomical Object Search
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label htmlFor="search">Search Objects</Label>
                    <form onSubmit={(e) => { e.preventDefault(); loadAstroObjects(searchQuery); }}>
                      <div className="flex">
                        <Input
                          id="search"
                          placeholder="Search by name (e.g., M31, Orion, NGC 7000)..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="mt-1 rounded-r-none"
                        />
                        <Button type="submit" className="mt-1 rounded-l-none">
                          <Search className="w-4 h-4" />
                        </Button>
                      </div>
                    </form>
                  </div>

                  {isLoading ? (
                    <div className="text-center py-8 text-muted-foreground">
                      Loading astronomical objects...
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {filteredObjects.length > 0 ? (
                        filteredObjects.slice(0, 20).map((obj) => (
                          <div
                            key={obj.id}
                            className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                              selectedObject?.id === obj.id
                                ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                                : 'border-gray-200 hover:border-gray-300 dark:border-gray-700'
                            }`}
                            onClick={() => setSelectedObject(obj)}
                          >
                            <div className="flex justify-between items-start">
                              <div>
                                <h3 className="font-medium">
                                  {obj.display_name || obj.name}
                                </h3>
                                <div className="text-sm text-muted-foreground space-x-4">
                                  <span>Type: {obj.otype || 'Unknown'}</span>
                                  <span>Mag: {obj.metadata_?.magnitude || 'N/A'}</span>
                                  {obj.metadata_?.ra && obj.metadata_?.dec && (
                                    <span>RA: {obj.metadata_?.ra} Dec: {obj.metadata_?.dec}</span>
                                  )}
                                </div>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedObject(obj);
                                  setShowAltitudeDialog(true);
                                }}
                              >
                                <Info className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-8 text-muted-foreground">
                          {searchQuery ? 'No objects found' : 'Start typing to search for objects'}
                        </div>
                      )}
                    </div>
                  )}

                  {selectedObject && (
                    <div className="mt-6 p-4 border rounded-lg bg-muted/50">
                      <h3 className="font-medium mb-2">Selected Object</h3>
                      <p className="text-lg font-semibold">
                        {selectedObject.display_name || selectedObject.name}
                      </p>
                      <div className="grid grid-cols-2 gap-4 mt-2 text-sm">
                        <div>
                          <span className="text-muted-foreground">Type: </span>
                          {selectedObject.otype || 'Unknown'}
                        </div>
                        <div>
                          <span className="text-muted-foreground">Magnitude: </span>
                          {selectedObject.metadata_?.magnitude || 'N/A'}
                        </div>
                        {selectedObject.metadata_?.ra && selectedObject.metadata_?.dec && (
                          <>
                            <div>
                              <span className="text-muted-foreground">RA: </span>
                              {selectedObject.metadata_?.ra}
                            </div>
                            <div>
                              <span className="text-muted-foreground">Dec: </span>
                              {selectedObject.metadata_?.dec}
                            </div>
                          </>
                        )}
                      </div>

                      <div className="flex gap-2 mt-4">
                        <Button
                          onClick={() => setShowAltitudeDialog(true)}
                          variant="outline"
                        >
                          View Altitude Chart
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="recommendations" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Telescope className="w-5 h-5" />
                    Bright Objects Visible Tonight
                  </CardTitle>
                  <div className="flex items-center justify-between mt-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPin className="w-4 h-4" />
                      <span>
                        Location: {userLocation?.city || "Getting location..."}
                        {locationError && " (Using default: NYC)"}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={getUserLocation}
                      disabled={locationLoading}
                    >
                      {locationLoading ? "Getting Location..." : "Update Location"}
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Currently visible objects above 20° altitude • Click to add to schedule
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="mb-4">
                    <Label htmlFor="object-filter">Filter by Type</Label>
                    <Select value={objectFilter} onValueChange={setObjectFilter}>
                      <SelectTrigger className="w-full mt-1">
                        <SelectValue placeholder="Select object type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Objects</SelectItem>
                        <SelectItem value="planet">Planets</SelectItem>
                        <SelectItem value="star">Bright Stars</SelectItem>
                        <SelectItem value="double-star">Double Stars</SelectItem>
                        <SelectItem value="open-cluster">Open Clusters</SelectItem>
                        <SelectItem value="globular-cluster">Globular Clusters</SelectItem>
                        <SelectItem value="galaxy">Galaxies</SelectItem>
                        <SelectItem value="nebula">Nebulae</SelectItem>
                        <SelectItem value="planetary-nebula">Planetary Nebulae</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-3">
                    {getRecommendedObjects().length > 0 ? (
                      getRecommendedObjects().map((obj) => (
                        <div
                          key={obj.id}
                          className="p-4 border rounded-lg cursor-pointer transition-colors border-gray-200 hover:border-blue-300 dark:border-gray-700 hover:bg-blue-50 dark:hover:bg-blue-950/50"
                          onClick={() => handleRecommendationClick(obj)}
                        >
                          <div className="flex justify-between items-start">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <h3 className="font-semibold text-lg">
                                  {obj.display_name || obj.name}
                                </h3>
                                <span className="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded-full">
                                  {obj.otype}
                                </span>
                              </div>

                              <p className="text-sm text-muted-foreground mb-2">
                                {obj.description}
                              </p>

                              <div className="grid grid-cols-2 gap-4 text-sm">
                                <div className="space-y-1">
                                  <div>
                                    <span className="text-muted-foreground">Magnitude: </span>
                                    <span className="font-medium">{obj.metadata_?.magnitude}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Altitude: </span>
                                    <span className="font-medium">{obj.altitude}°</span>
                                  </div>
                                </div>
                                <div className="space-y-1">
                                  <div>
                                    <span className="text-muted-foreground">Direction: </span>
                                    <span className="font-medium">{obj.direction}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Azimuth: </span>
                                    <span className="font-medium">{obj.azimuth}°</span>
                                  </div>
                                </div>
                              </div>
                            </div>

                            <div className="flex flex-col gap-2 ml-4">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedObject(obj);
                                  setShowAltitudeDialog(true);
                                }}
                                title="View altitude chart"
                              >
                                <Info className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-center py-8 text-muted-foreground">
                        <Telescope className="w-12 h-12 mx-auto mb-4 opacity-50" />
                        <p className="text-lg font-medium mb-2">No bright objects currently visible</p>
                        <p className="text-sm">
                          Objects need to be at least 20° above the horizon to be recommended.
                          Try checking back in a few hours as the sky rotates.
                        </p>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="schedule" className="space-y-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      <Calendar className="w-5 h-5" />
                      Observation Schedules
                    </CardTitle>
                    <Dialog open={showNewScheduleDialog} onOpenChange={setShowNewScheduleDialog}>
                      <DialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          <Plus className="w-4 h-4 mr-2" />
                          New Schedule
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Create New Schedule</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-4">
                          <div>
                            <Label htmlFor="scheduleName">Schedule Name</Label>
                            <Input
                              id="scheduleName"
                              value={newScheduleName}
                              onChange={(e) => setNewScheduleName(e.target.value)}
                              placeholder="e.g., Tonight's Session, Deep Sky Objects"
                              className="mt-1"
                            />
                          </div>
                          <div>
                            <Label htmlFor="scheduleDescription">Description (optional)</Label>
                            <Textarea
                              id="scheduleDescription"
                              value={newScheduleDescription}
                              onChange={(e) => setNewScheduleDescription(e.target.value)}
                              placeholder="Description of this observing session..."
                              className="mt-1"
                            />
                          </div>
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" onClick={() => setShowNewScheduleDialog(false)}>
                              Cancel
                            </Button>
                            <Button onClick={createNewSchedule}>
                              Create Schedule
                            </Button>
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </div>

                  {/* Schedule Selector */}
                  {schedules.length > 0 && (
                    <div className="flex items-center gap-2 pt-2">
                      <Label>Active Schedule:</Label>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="outline" className="flex items-center gap-2">
                            {activeSchedule?.name || 'Select Schedule'}
                            <ChevronDown className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {schedules.map((schedule) => (
                            <DropdownMenuItem
                              key={schedule.id}
                              onClick={() => switchSchedule(schedule)}
                              className="flex items-center justify-between"
                            >
                              <span>{schedule.name}</span>
                              {schedule.is_active && <span className="text-xs text-blue-500">Active</span>}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>

                      {/* Schedule Actions */}
                      {activeSchedule && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <MoreVertical className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            <DropdownMenuItem onClick={() => deleteSchedule(activeSchedule)}>
                              <Trash2 className="w-4 h-4 mr-2" />
                              Delete Schedule
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  )}
                </CardHeader>

                <CardContent className="space-y-4">
                  {!activeSchedule && schedules.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <Calendar className="w-12 h-12 mx-auto mb-4 opacity-50" />
                      <p className="text-lg font-medium mb-2">No schedules yet</p>
                      <p className="text-sm mb-4">Create your first observation schedule to get started</p>
                      <Button onClick={() => setShowNewScheduleDialog(true)}>
                        <Plus className="w-4 h-4 mr-2" />
                        Create Your First Schedule
                      </Button>
                    </div>
                  ) : (
                    <>
                      {selectedObject && activeSchedule && (
                        <div className="p-4 border rounded-lg bg-muted/50">
                          <h3 className="font-medium mb-3">Add to {activeSchedule.name}</h3>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                              <Label htmlFor="startTime">Start Time</Label>
                              <Input
                                id="startTime"
                                type="time"
                                value={newItemStartTime}
                                onChange={(e) => setNewItemStartTime(e.target.value)}
                                className="mt-1"
                              />
                            </div>
                            <div>
                              <Label htmlFor="duration">Duration (minutes)</Label>
                              <Input
                                id="duration"
                                type="number"
                                min="5"
                                max="300"
                                value={newItemDuration}
                                onChange={(e) => setNewItemDuration(parseInt(e.target.value) || 30)}
                                className="mt-1"
                              />
                            </div>
                            <div className="flex items-end">
                              <Button onClick={addToSchedule} className="w-full">
                                <Plus className="w-4 h-4 mr-2" />
                                Add to Schedule
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}

                      {activeSchedule && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <h3 className="font-medium">{activeSchedule.name}</h3>
                            <span className="text-sm text-muted-foreground">
                              {activeSchedule.items.length} object{activeSchedule.items.length !== 1 ? 's' : ''}
                            </span>
                          </div>

                          {activeSchedule.description && (
                            <p className="text-sm text-muted-foreground">{activeSchedule.description}</p>
                          )}

                          {activeSchedule.items.length > 0 ? (
                            activeSchedule.items.map((item) => (
                              <div
                                key={item.id}
                                className="p-3 border rounded-lg flex justify-between items-center"
                              >
                                <div>
                                  <h4 className="font-medium">{item.objectName}</h4>
                                  <div className="text-sm text-muted-foreground flex items-center gap-4">
                                    <span className="flex items-center gap-1">
                                      <Clock className="w-3 h-3" />
                                      {formatTime(item.startTime)} - {calculateEndTime(item.startTime, item.duration)}
                                    </span>
                                    <span>{item.duration} min</span>
                                    <span>Mag: {item.magnitude}</span>
                                  </div>
                                </div>
                                <div className="flex gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => editScheduleItem(item)}
                                    title="Edit schedule item"
                                  >
                                    <Edit className="w-4 h-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => removeFromSchedule(item.id)}
                                    title="Remove from schedule"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="text-center py-8 text-muted-foreground">
                              <Calendar className="w-8 h-8 mx-auto mb-2 opacity-50" />
                              <p>No objects in this schedule yet.</p>
                              <p className="text-sm">Select an object from the other tabs to add it here.</p>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="skymap" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Map className="w-5 h-5" />
                    Interactive Sky Maps
                  </CardTitle>
                  <div className="flex items-center justify-between mt-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPin className="w-4 h-4" />
                      <span>
                        Location: {userLocation?.city || "Getting location..."}
                        {locationError && " (Using default: NYC)"}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={getUserLocation}
                      disabled={locationLoading}
                    >
                      {locationLoading ? "Getting Location..." : "Update Location"}
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Real-time interactive sky maps showing stars, constellations, and celestial objects
                  </p>
                </CardHeader>
                <CardContent>
                      <AladinLite
                        width={800}
                        height={600}
                        className="w-full"
                        userLocation={userLocation}
                        isLoaded={isLoaded}
                      />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        {/* Sidebar */}
        <div className={`relative transition-all duration-300 ${sidebarCollapsed ? 'hidden lg:block lg:w-12' : 'space-y-6'}`}>
          {/* Sidebar Toggle Button */}
          <div className="absolute -left-4 top-0 z-10">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="h-8 w-8 p-0 bg-white shadow-md hover:shadow-lg transition-shadow"
            >
              {sidebarCollapsed ? (
                <ChevronLeft className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </Button>
          </div>
          
          {/* Sidebar Content */}
          <div className={`transition-all duration-300 ${sidebarCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
            <WeatherConditions />
            <MoonPhase />
            {/*<StarMap width={350} height={350} />*/}
          </div>
        </div>
      </div>

      {/* Altitude Dialog */}
      {selectedObject && (
        <ObjectAltitudeDialog
          open={showAltitudeDialog}
          onOpenChange={setShowAltitudeDialog}
          objectName={selectedObject.display_name || selectedObject.name}
          ra={selectedObject.metadata_?.ra || '0'}
          dec={selectedObject.metadata_?.dec || '0'}
        />
      )}

      {/* Edit Schedule Item Dialog */}
      <EditScheduleItemDialog
        open={showEditItemDialog}
        onOpenChange={setShowEditItemDialog}
        item={editingItem}
        onSave={saveEditedItem}
        activeSchedule={activeSchedule}
        userLocation={userLocation}
      />

      {/* Add to Schedule Dialog */}
      <Dialog open={showAddToScheduleDialog} onOpenChange={setShowAddToScheduleDialog}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add to Schedule</DialogTitle>
          </DialogHeader>

          {selectedRecommendation && (
            <div className="space-y-6">
              {/* Object Details */}
              <div className="p-3 border rounded-lg bg-muted/50">
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="font-semibold text-lg">
                    {selectedRecommendation.display_name || selectedRecommendation.name}
                  </h3>
                  <span className="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded-full">
                    {selectedRecommendation.otype || selectedRecommendation.type}
                  </span>
                </div>

                <p className="text-sm text-muted-foreground mb-2">
                  {selectedRecommendation.description}
                </p>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Magnitude: </span>
                    <span className="font-medium">
                      {selectedRecommendation.metadata_?.magnitude || selectedRecommendation.magnitude}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Altitude: </span>
                    <span className="font-medium">{selectedRecommendation.altitude}°</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Direction: </span>
                    <span className="font-medium">{selectedRecommendation.direction}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Azimuth: </span>
                    <span className="font-medium">{selectedRecommendation.azimuth}°</span>
                  </div>
                </div>
              </div>

              {/* Altitude Chart */}
              <div className="space-y-2">
                <h4 className="font-medium">Tonight&apos;s Altitude Profile</h4>
                <div className="p-4 border rounded-lg bg-white dark:bg-gray-900">
                  {(() => {
                    const altitudeData = getRecommendationAltitudeData();
                    if (altitudeData.length === 0) {
                      return (
                        <div className="text-center py-8 text-muted-foreground">
                          <p>Unable to generate altitude chart</p>
                          <p className="text-sm">Check object coordinates</p>
                        </div>
                      );
                    }

                    // const maxAlt = Math.max(...altitudeData.map(d => d.altitude));
                    const chartHeight = 200;
                    const chartWidth = 600;
                    const padding = 40;

                    return (
                      <div className="relative">
                        <svg width={chartWidth} height={chartHeight + padding * 2} className="w-full">
                          {/* Grid lines */}
                          {[0, 20, 40, 60, 80].map(alt => (
                            <g key={alt}>
                              <line
                                x1={padding}
                                y1={padding + chartHeight - (alt / 90) * chartHeight}
                                x2={chartWidth - padding}
                                y2={padding + chartHeight - (alt / 90) * chartHeight}
                                stroke="#e5e7eb"
                                strokeWidth="1"
                                strokeDasharray="2,2"
                              />
                              <text
                                x={padding - 5}
                                y={padding + chartHeight - (alt / 90) * chartHeight + 4}
                                fontSize="12"
                                fill="#6b7280"
                                textAnchor="end"
                              >
                                {alt}°
                              </text>
                            </g>
                          ))}

                          {/* Time labels */}
                          {altitudeData.filter((_, i) => i % 6 === 0).map((point, i) => (
                            <text
                              key={i}
                              x={padding + (i * 6 / (altitudeData.length - 1)) * (chartWidth - 2 * padding)}
                              y={chartHeight + padding + 20}
                              fontSize="12"
                              fill="#6b7280"
                              textAnchor="middle"
                            >
                              {formatAstroTime(point.time)}
                            </text>
                          ))}

                          {/* Altitude curve */}
                          <path
                            d={`M ${altitudeData.map((point, i) => 
                              `${padding + (i / (altitudeData.length - 1)) * (chartWidth - 2 * padding)},${
                                padding + chartHeight - (Math.max(0, point.altitude) / 90) * chartHeight
                              }`
                            ).join(' L ')}`}
                            fill="none"
                            stroke="#3b82f6"
                            strokeWidth="2"
                          />

                          {/* Horizon line */}
                          <line
                            x1={padding}
                            y1={padding + chartHeight}
                            x2={chartWidth - padding}
                            y2={padding + chartHeight}
                            stroke="#ef4444"
                            strokeWidth="2"
                          />

                          {/* Ideal observation zone (above 20°) */}
                          <rect
                            x={padding}
                            y={padding + chartHeight - (20 / 90) * chartHeight}
                            width={chartWidth - 2 * padding}
                            height={(20 / 90) * chartHeight}
                            fill="rgba(34, 197, 94, 0.1)"
                          />

                          {/* Existing schedule items */}
                          {activeSchedule?.items.map((item, i) => {
                            const startMinutes = parseInt(item.startTime.split(':')[0]) * 60 + parseInt(item.startTime.split(':')[1]);
                            // const endMinutes = startMinutes + item.duration;

                            // Convert to chart position (assuming 18:00 to 06:00 time range)
                            const startPos = ((startMinutes - 18 * 60) / (12 * 60)) * (chartWidth - 2 * padding);
                            const width = (item.duration / (12 * 60)) * (chartWidth - 2 * padding);

                            if (startPos >= 0 && startPos <= chartWidth - 2 * padding) {
                              return (
                                <g key={i}>
                                  <rect
                                    x={padding + startPos}
                                    y={padding}
                                    width={Math.min(width, chartWidth - 2 * padding - startPos)}
                                    height={chartHeight}
                                    fill="rgba(239, 68, 68, 0.2)"
                                    stroke="#ef4444"
                                    strokeWidth="1"
                                    strokeDasharray="3,3"
                                  />
                                  <text
                                    x={padding + startPos + 5}
                                    y={padding + 15}
                                    fontSize="10"
                                    fill="#dc2626"
                                    fontWeight="bold"
                                  >
                                    {item.objectName}
                                  </text>
                                </g>
                              );
                            }
                            return null;
                          })}

                          {/* Current time selected */}
                          {quickAddStartTime && (() => {
                            const [hours, minutes] = quickAddStartTime.split(':').map(Number);
                            const totalMinutes = hours * 60 + minutes;
                            const pos = ((totalMinutes - 18 * 60) / (12 * 60)) * (chartWidth - 2 * padding);
                            const width = (quickAddDuration / (12 * 60)) * (chartWidth - 2 * padding);

                            if (pos >= 0 && pos <= chartWidth - 2 * padding) {
                              return (
                                <g>
                                  <rect
                                    x={padding + pos}
                                    y={padding}
                                    width={Math.min(width, chartWidth - 2 * padding - pos)}
                                    height={chartHeight}
                                    fill="rgba(59, 130, 246, 0.3)"
                                    stroke="#3b82f6"
                                    strokeWidth="2"
                                  />
                                  <text
                                    x={padding + pos + 5}
                                    y={padding + 30}
                                    fontSize="10"
                                    fill="#1d4ed8"
                                    fontWeight="bold"
                                  >
                                    New: {selectedRecommendation.name}
                                  </text>
                                </g>
                              );
                            }
                            return null;
                          })()}
                        </svg>

                        {/* Legend */}
                        <div className="flex flex-wrap gap-4 mt-2 text-xs">
                          <div className="flex items-center gap-1">
                            <div className="w-3 h-3 bg-blue-500 rounded"></div>
                            <span>Altitude curve</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <div className="w-3 h-3 bg-green-500/20 border border-green-500 rounded"></div>
                            <span>Good observing (20°+)</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <div className="w-3 h-3 bg-red-500 rounded"></div>
                            <span>Horizon (0°)</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <div className="w-3 h-3 bg-red-500/20 border border-red-500 border-dashed rounded"></div>
                            <span>Existing schedule</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <div className="w-3 h-3 bg-blue-500/30 border border-blue-500 rounded"></div>
                            <span>New observation</span>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Schedule Selection */}
              {activeSchedule ? (
                <div>
                  <Label className="text-sm font-medium">
                    Adding to: <span className="text-blue-600">{activeSchedule.name}</span>
                  </Label>
                </div>
              ) : (
                <div className="p-3 border rounded-lg bg-yellow-50 dark:bg-yellow-900/20">
                  <p className="text-sm text-yellow-800 dark:text-yellow-200">
                    No active schedule. Please create a schedule first.
                  </p>
                </div>
              )}

              {/* Time Settings */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="quickStartTime">Start Time</Label>
                  <Input
                    id="quickStartTime"
                    type="time"
                    value={quickAddStartTime}
                    onChange={(e) => setQuickAddStartTime(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="quickDuration">Duration (minutes)</Label>
                  <Input
                    id="quickDuration"
                    type="number"
                    min="5"
                    max="300"
                    value={quickAddDuration}
                    onChange={(e) => setQuickAddDuration(parseInt(e.target.value) || 30)}
                    className="mt-1"
                  />
                </div>
              </div>

              {/* Schedule Conflicts */}
              {quickAddStartTime && (() => {
                const conflicts = getScheduleConflicts(quickAddStartTime, quickAddDuration);
                if (conflicts.length > 0) {
                  return (
                    <div className="p-3 border rounded-lg bg-red-50 dark:bg-red-900/20">
                      <h4 className="font-medium text-red-800 dark:text-red-200 mb-2">
                        Schedule Conflicts Detected
                      </h4>
                      <div className="space-y-1">
                        {conflicts.map((conflict) => (
                          <div key={conflict.id} className="text-sm text-red-700 dark:text-red-300">
                            <span className="font-medium">{conflict.objectName}</span>
                            <span className="ml-2">
                              {formatTime(conflict.startTime)} - {calculateEndTime(conflict.startTime, conflict.duration)}
                            </span>
                            <span className="ml-2">({conflict.duration} min)</span>
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-red-600 dark:text-red-400 mt-2">
                        Consider adjusting the start time to avoid conflicts.
                      </p>
                    </div>
                  );
                }
                return null;
              })()}

              {/* Current Schedule Overview */}
              {activeSchedule && activeSchedule.items.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-medium">Current Schedule Overview</h4>
                  <div className="p-3 border rounded-lg bg-muted/50 max-h-32 overflow-y-auto">
                    <div className="space-y-1">
                      {activeSchedule.items
                        .sort((a, b) => a.startTime.localeCompare(b.startTime))
                        .map((item) => (
                          <div key={item.id} className="text-sm flex justify-between items-center">
                            <span className="font-medium">{item.objectName}</span>
                            <span className="text-muted-foreground">
                              {formatTime(item.startTime)} - {calculateEndTime(item.startTime, item.duration)}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setShowAddToScheduleDialog(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={addRecommendationToSchedule}
                  disabled={!activeSchedule || !quickAddStartTime}
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add to Schedule
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
