import SunCalc from "suncalc"

interface Coordinates {
  latitude: number;
  longitude: number;
}

// ============================================================================
// Equipment Management
// ============================================================================

export interface Telescope {
  name: string;
  aperture?: number;       // mm
  focalLength?: number;    // mm
  type?: string;           // e.g., "Refractor", "Reflector", "SCT", "Cassegrain"
}

export interface Mount {
  name: string;
  type?: string;           // e.g., "EQ", "Alt-Az", "Dobsonian", "Fork"
}

export interface Camera {
  name: string;
  sensorWidth?: number;    // mm
  sensorHeight?: number;   // mm
  pixelSize?: number;      // microns
  resolution?: string;     // e.g., "4656 x 3520"
}

export interface Filter {
  name: string;
  type?: string;           // e.g., "LRGB", "Narrowband", "UV/IR Cut"
}

export interface GuideScope {
  name: string;
  aperture?: number;       // mm
  focalLength?: number;    // mm
}

export interface GuideCamera {
  name: string;
  pixelSize?: number;      // microns
}

export interface EquipmentSet {
  id: string;
  name: string;
  telescope?: Telescope;
  mount?: Mount;
  camera?: Camera;
  filters?: Filter[];
  guideScope?: GuideScope;
  guideCamera?: GuideCamera;
}

export interface EquipmentState {
  equipmentSets: EquipmentSet[];
}

const EQUIPMENT_STORAGE_KEY = "equipment_sets";

/**
 * Generate a unique ID for a new equipment set
 */
export function generateEquipmentId(): string {
  return crypto.randomUUID();
}

/**
 * Load all equipment sets from localStorage
 */
export function loadEquipment(): EquipmentState {
  const saved = localStorage.getItem(EQUIPMENT_STORAGE_KEY);
  if (!saved) {
    return { equipmentSets: [] };
  }

  try {
    return JSON.parse(saved) as EquipmentState;
  } catch {
    return { equipmentSets: [] };
  }
}

/**
 * Save all equipment sets to localStorage
 */
export function saveEquipment(state: EquipmentState): void {
  localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(state));
}

/**
 * Add a new equipment set
 */
export function addEquipmentSet(equipment: Omit<EquipmentSet, 'id'>): EquipmentSet {
  const state = loadEquipment();
  const newEquipment: EquipmentSet = {
    ...equipment,
    id: generateEquipmentId(),
  };
  state.equipmentSets.push(newEquipment);
  saveEquipment(state);
  return newEquipment;
}

/**
 * Update an existing equipment set
 */
export function updateEquipmentSet(equipmentId: string, updates: Partial<Omit<EquipmentSet, 'id'>>): void {
  const state = loadEquipment();
  const index = state.equipmentSets.findIndex(eq => eq.id === equipmentId);
  if (index !== -1) {
    state.equipmentSets[index] = { ...state.equipmentSets[index], ...updates };
    saveEquipment(state);
  }
}

/**
 * Delete an equipment set
 */
export function deleteEquipmentSet(equipmentId: string): void {
  const state = loadEquipment();
  state.equipmentSets = state.equipmentSets.filter(eq => eq.id !== equipmentId);
  saveEquipment(state);
}

// ============================================================================
// Location Management
// ============================================================================

export interface ObserverLocation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  horizon?: HorizonProfile;
  equipmentIds?: string[];  // References to associated equipment sets
  isActive?: boolean;
}

export interface LocationsState {
  locations: ObserverLocation[];
  activeLocationId: string | null;
}

const LOCATIONS_STORAGE_KEY = "observer_locations";

/**
 * Generate a unique ID for a new location
 */
export function generateLocationId(): string {
  return crypto.randomUUID();
}

/**
 * Load all locations from localStorage
 */
export function loadLocations(): LocationsState {
  const saved = localStorage.getItem(LOCATIONS_STORAGE_KEY);
  if (!saved) {
    // Migrate from old single-location format if it exists
    const oldLocation = localStorage.getItem("observer_location");
    const oldHorizon = loadHorizonProfile();

    if (oldLocation) {
      try {
        const parsed = JSON.parse(oldLocation);
        const migratedLocation: ObserverLocation = {
          id: generateLocationId(),
          name: parsed.name || "Default Location",
          latitude: parsed.latitude,
          longitude: parsed.longitude,
          horizon: oldHorizon || undefined,
          isActive: true,
        };
        const state: LocationsState = {
          locations: [migratedLocation],
          activeLocationId: migratedLocation.id,
        };
        saveLocations(state);
        // Clean up old storage
        localStorage.removeItem("observer_location");
        localStorage.removeItem("horizon_profile");
        return state;
      } catch {
        // Ignore parse errors
      }
    }

    return { locations: [], activeLocationId: null };
  }

  try {
    return JSON.parse(saved) as LocationsState;
  } catch {
    return { locations: [], activeLocationId: null };
  }
}

/**
 * Save all locations to localStorage
 */
export function saveLocations(state: LocationsState): void {
  localStorage.setItem(LOCATIONS_STORAGE_KEY, JSON.stringify(state));
}

/**
 * Get the currently active location
 */
export function getActiveLocation(): ObserverLocation | null {
  const state = loadLocations();
  if (!state.activeLocationId) return null;
  return state.locations.find(loc => loc.id === state.activeLocationId) || null;
}

/**
 * Set the active location by ID
 */
export function setActiveLocation(locationId: string): void {
  const state = loadLocations();
  if (state.locations.some(loc => loc.id === locationId)) {
    state.activeLocationId = locationId;
    saveLocations(state);
  }
}

/**
 * Add a new location
 */
export function addLocation(location: Omit<ObserverLocation, 'id'>): ObserverLocation {
  const state = loadLocations();
  const newLocation: ObserverLocation = {
    ...location,
    id: generateLocationId(),
  };
  state.locations.push(newLocation);

  // If this is the first location, make it active
  if (state.locations.length === 1) {
    state.activeLocationId = newLocation.id;
  }

  saveLocations(state);
  return newLocation;
}

/**
 * Update an existing location
 */
export function updateLocation(locationId: string, updates: Partial<Omit<ObserverLocation, 'id'>>): void {
  const state = loadLocations();
  const index = state.locations.findIndex(loc => loc.id === locationId);
  if (index !== -1) {
    state.locations[index] = { ...state.locations[index], ...updates };
    saveLocations(state);
  }
}

/**
 * Delete a location
 */
export function deleteLocation(locationId: string): void {
  const state = loadLocations();
  state.locations = state.locations.filter(loc => loc.id !== locationId);

  // If we deleted the active location, set a new active one
  if (state.activeLocationId === locationId) {
    state.activeLocationId = state.locations.length > 0 ? state.locations[0].id : null;
  }

  saveLocations(state);
}

/**
 * Get the horizon profile for the active location
 */
export function getActiveHorizonProfile(): HorizonProfile | null {
  const activeLocation = getActiveLocation();
  return activeLocation?.horizon || null;
}

export interface AltitudePoint {
  time: Date;
  altitude: number;
  azimuth: number;
  isIdeal: boolean;
}

// Horizon profile types
export interface HorizonPoint {
  azimuth: number;  // 0-360 degrees
  altitude: number; // degrees above mathematical horizon
}

export interface HorizonProfile {
  name?: string;
  points: HorizonPoint[];
}

/**
 * Parse a horizon file text into a HorizonProfile
 * Format: each line contains "azimuth altitude" (space-separated degrees)
 */
export function parseHorizonFile(text: string): HorizonProfile {
  const lines = text.trim().split('\n');
  const points: HorizonPoint[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue; // Skip empty lines and comments

    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const azimuth = parseFloat(parts[0]);
      const altitude = parseFloat(parts[1]);

      if (!isNaN(azimuth) && !isNaN(altitude)) {
        // Normalize azimuth to 0-360
        const normalizedAz = ((azimuth % 360) + 360) % 360;
        points.push({ azimuth: normalizedAz, altitude });
      }
    }
  }

  // Sort by azimuth for interpolation
  points.sort((a, b) => a.azimuth - b.azimuth);

  return { points };
}

/**
 * Get the horizon altitude at a specific azimuth by interpolating between points
 */
export function getHorizonAltitude(profile: HorizonProfile, azimuth: number): number {
  if (profile.points.length === 0) return 0;
  if (profile.points.length === 1) return profile.points[0].altitude;

  // Normalize azimuth to 0-360
  const az = ((azimuth % 360) + 360) % 360;

  // Find the two points that bracket this azimuth
  let lowPoint: HorizonPoint | null = null;
  let highPoint: HorizonPoint | null = null;

  for (let i = 0; i < profile.points.length; i++) {
    if (profile.points[i].azimuth <= az) {
      lowPoint = profile.points[i];
    }
    if (profile.points[i].azimuth >= az && !highPoint) {
      highPoint = profile.points[i];
    }
  }

  // Handle wrap-around (e.g., azimuth between last point and first point)
  if (!lowPoint) {
    // Azimuth is before the first point, wrap from last point
    lowPoint = profile.points[profile.points.length - 1];
  }
  if (!highPoint) {
    // Azimuth is after the last point, wrap to first point
    highPoint = profile.points[0];
  }

  // If same point or very close azimuths, return the altitude
  if (lowPoint === highPoint || Math.abs(lowPoint.azimuth - highPoint.azimuth) < 0.01) {
    return lowPoint.altitude;
  }

  // Linear interpolation
  let azRange: number;
  let azOffset: number;

  if (highPoint.azimuth < lowPoint.azimuth) {
    // Wrap-around case
    azRange = (360 - lowPoint.azimuth) + highPoint.azimuth;
    azOffset = az >= lowPoint.azimuth ? (az - lowPoint.azimuth) : (360 - lowPoint.azimuth + az);
  } else {
    azRange = highPoint.azimuth - lowPoint.azimuth;
    azOffset = az - lowPoint.azimuth;
  }

  const t = azOffset / azRange;
  return lowPoint.altitude + t * (highPoint.altitude - lowPoint.altitude);
}

/**
 * Check if an object at given altitude/azimuth is above the local horizon
 */
export function isAboveLocalHorizon(
  altitude: number,
  azimuth: number,
  horizonProfile: HorizonProfile | null
): boolean {
  if (!horizonProfile || horizonProfile.points.length === 0) {
    // No horizon profile, use default 0° horizon
    return altitude > 0;
  }
  const horizonAlt = getHorizonAltitude(horizonProfile, azimuth);
  return altitude > horizonAlt;
}

/**
 * Load horizon profile from localStorage
 */
export function loadHorizonProfile(): HorizonProfile | null {
  const saved = localStorage.getItem("horizon_profile");
  if (!saved) return null;
  try {
    return JSON.parse(saved) as HorizonProfile;
  } catch {
    return null;
  }
}

/**
 * Save horizon profile to localStorage
 */
export function saveHorizonProfile(profile: HorizonProfile | null): void {
  if (profile) {
    localStorage.setItem("horizon_profile", JSON.stringify(profile));
  } else {
    localStorage.removeItem("horizon_profile");
  }
}

// Convert RA (HH:MM:SS) and Dec (DD:MM:SS) to decimal degrees
export function parseCoordinates(ra: string, dec: string): { raDeg: number; decDeg: number } | null {
  try {
    // Parse RA (right ascension) - handles both integer and decimal seconds
    // Matches formats like "05h 35m 17s" or "05h 35m 17.30s"
    const raMatch = ra.match(/(\d+)h\s*(\d+)m\s*([\d.]+)s/);
    if (!raMatch) return null;

    const raHours = parseInt(raMatch[1]);
    const raMinutes = parseInt(raMatch[2]);
    const raSeconds = parseFloat(raMatch[3]);

    const raDeg = (raHours + raMinutes/60 + raSeconds/3600) * 15; // 15 degrees per hour

    // Parse Dec (declination) - handles both integer and decimal arcseconds
    // Matches formats like "+22° 00' 52"" or "+22° 00' 52.10""
    const decMatch = dec.match(/([+-])(\d+)°\s*(\d+)'\s*([\d.]+)"/);
    if (!decMatch) return null;

    const decSign = decMatch[1] === "-" ? -1 : 1;
    const decDegrees = parseInt(decMatch[2]);
    const decMinutes = parseInt(decMatch[3]);
    const decSeconds = parseFloat(decMatch[4]);

    const decDeg = decSign * (decDegrees + decMinutes/60 + decSeconds/3600);

    return { raDeg, decDeg };
  } catch (e) {
    console.error("Error parsing coordinates:", e);
    return null;
  }
}

// Calculate the current altitude of an object
export function calculateCurrentAltitude(
  raDeg: number,
  decDeg: number,
  coordinates: Coordinates
): number {
  const now = new Date();
  return calculateAltitudeAtTime(raDeg, decDeg, coordinates, now);
}

// Calculate the altitude of an object at a specific time
export function calculateAltitudeAtTime(
  raDeg: number,
  decDeg: number,
  coordinates: Coordinates,
  time: Date
): number {
  // Convert RA and Dec to radians
  const raRad = raDeg * Math.PI / 180;
  const decRad = decDeg * Math.PI / 180;

  // Get the observer's location in radians
  const latRad = coordinates.latitude * Math.PI / 180;

  // Calculate Local Sidereal Time (LST)
  const jd = time.getTime() / 86400000 + 2440587.5; // Julian date
  const jdRef = Math.floor(jd - 0.5) + 0.5;
  const T = (jdRef - 2451545.0) / 36525;
  const theta0 = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - T * T * T / 38710000;

  // Adjust for observer's longitude
  const lst = (theta0 + coordinates.longitude) % 360;
  const lstRad = lst * Math.PI / 180;

  // Calculate hour angle
  const ha = lstRad - raRad;

  // Calculate altitude
  const sinAlt = Math.sin(decRad) * Math.sin(latRad) + Math.cos(decRad) * Math.cos(latRad) * Math.cos(ha);
  const altRad = Math.asin(sinAlt);
  const altDeg = altRad * 180 / Math.PI;

  return altDeg;
}

// Calculate azimuth at a specific time
export function calculateAzimuthAtTime(
  raDeg: number,
  decDeg: number,
  coordinates: Coordinates,
  time: Date
): number {
  // Convert RA and Dec to radians
  const raRad = raDeg * Math.PI / 180;
  const decRad = decDeg * Math.PI / 180;

  // Get the observer's location in radians
  const latRad = coordinates.latitude * Math.PI / 180;

  // Calculate Local Sidereal Time (LST)
  const jd = time.getTime() / 86400000 + 2440587.5; // Julian date
  const jdRef = Math.floor(jd - 0.5) + 0.5;
  const T = (jdRef - 2451545.0) / 36525;
  const theta0 = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - T * T * T / 38710000;

  // Adjust for observer's longitude
  const lst = (theta0 + coordinates.longitude) % 360;
  const lstRad = lst * Math.PI / 180;

  // Calculate hour angle
  const ha = lstRad - raRad;

  // Calculate azimuth
  const sinHa = Math.sin(ha);
  const cosHa = Math.cos(ha);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const tanDec = Math.tan(decRad);

  let azimuth = Math.atan2(sinHa, cosHa * sinLat - tanDec * cosLat);

  // Convert to degrees and normalize to 0-360
  azimuth = azimuth * 180 / Math.PI;
  azimuth = (azimuth + 180) % 360;

  return azimuth;
}

// Generate altitude data for an entire night
export function generateNightAltitudeData(
  raDeg: number,
  decDeg: number,
  coordinates: Coordinates
): AltitudePoint[] {
  const today = new Date();
  today.setHours(12, 0, 0, 0); // Set to noon today

  // Get sunset and sunrise times
  const sunTimes = SunCalc.getTimes(today, coordinates.latitude, coordinates.longitude);
  const sunset = sunTimes.sunset;

  // Get tomorrow's sunrise
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowSunTimes = SunCalc.getTimes(tomorrow, coordinates.latitude, coordinates.longitude);
  const sunrise = tomorrowSunTimes.sunrise;

  // Generate data points from sunset to sunrise
  const dataPoints: AltitudePoint[] = [];
  const totalMinutes = (sunrise.getTime() - sunset.getTime()) / (1000 * 60);
  const interval = Math.max(10, Math.floor(totalMinutes / 60)); // At least 10 minutes, or enough for 60 data points

  // Start from sunset, go until sunrise
  const current = new Date(sunset);

  while (current <= sunrise) {
    const altitude = calculateAltitudeAtTime(raDeg, decDeg, coordinates, current);
    const azimuth = calculateAzimuthAtTime(raDeg, decDeg, coordinates, current);
    dataPoints.push({
      time: new Date(current),
      altitude,
      azimuth,
      isIdeal: altitude > 20 // Ideal if altitude > 20 degrees
    });
    current.setMinutes(current.getMinutes() + interval);
  }

  return dataPoints;
}

// Get the time when object reaches maximum altitude
export function getMaxAltitudeTime(altitudeData: AltitudePoint[]): Date | null {
  if (altitudeData.length === 0) return null;

  let maxPoint = altitudeData[0];

  for (let i = 1; i < altitudeData.length; i++) {
    if (altitudeData[i].altitude > maxPoint.altitude) {
      maxPoint = altitudeData[i];
    }
  }

  return maxPoint.time;
}

// Get the ideal observation time range
export function getIdealObservationTimeRange(altitudeData: AltitudePoint[]): { start: Date | null; end: Date | null } {
  const idealPoints = altitudeData.filter(point => point.isIdeal);

  if (idealPoints.length === 0) {
    return { start: null, end: null };
  }

  return {
    start: idealPoints[0].time,
    end: idealPoints[idealPoints.length - 1].time
  };
}

// Format time as HH:MM in 24-hour format
export function formatTime(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

// Parse time string "HH:MM" to hours and minutes
export function parseTimeString(timeStr: string): { hours: number; minutes: number } | null {
  if (!timeStr) return null;

  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);

  if (isNaN(hours) || isNaN(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return { hours, minutes };
}

// Compare two times for astronomical sorting (evening to morning)
// This function considers times after midnight as "later" than times before midnight
export function compareAstronomicalTimes(timeA: string, timeB: string): number {
  // Handle empty strings or invalid times
  if (!timeA && !timeB) return 0;
  if (!timeA) return 1; // Empty times come last
  if (!timeB) return -1;

  const parsedA = parseTimeString(timeA);
  const parsedB = parseTimeString(timeB);

  if (!parsedA && !parsedB) return 0;
  if (!parsedA) return 1;
  if (!parsedB) return -1;

  // Convert to "astronomical day" where:
  // - Evening times (6 PM to midnight): 18:00 to 23:59 becomes 18:00 to 23:59
  // - Morning times (midnight to noon): 00:00 to 12:00 becomes 24:00 to 36:00
  // This ensures proper order across midnight boundary
  const adjustHoursA = parsedA.hours < 12 ? parsedA.hours + 24 : parsedA.hours;
  const adjustHoursB = parsedB.hours < 12 ? parsedB.hours + 24 : parsedB.hours;

  // Compare the adjusted hours first
  if (adjustHoursA !== adjustHoursB) {
    return adjustHoursA - adjustHoursB;
  }

  // If hours are the same, compare minutes
  return parsedA.minutes - parsedB.minutes;
}

// Default coordinates (can be overridden by user settings)
export const defaultCoordinates: Coordinates = {
  latitude: 40.7128, // Default to New York
  longitude: -74.0060
};

// Add this new function to calculate azimuth
export function calculateCurrentAzimuth(raDeg: number, decDeg: number, observerCoordinates: Coordinates): number {
  // Get the current time and convert to UTC
  const now = new Date();

  // Get local sidereal time (LST)
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const dayOfYear = getDayOfYear(now);
  const lst = getSiderealTime(utcHours, dayOfYear, observerCoordinates.longitude);

  // Convert RA to hour angle
  // Hour angle = LST - RA (in degrees)
  const hourAngle = lst * 15 - raDeg;

  // Convert all angles to radians for calculations
  const hourAngleRad = toRadians(hourAngle);
  const decRad = toRadians(decDeg);
  const latRad = toRadians(observerCoordinates.latitude);

  // Calculate azimuth
  // Formula: azimuth = atan2(sin(hourAngle), cos(hourAngle) * sin(latitude) - tan(declination) * cos(latitude))
  const sinHourAngle = Math.sin(hourAngleRad);
  const cosHourAngle = Math.cos(hourAngleRad);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const tanDec = Math.tan(decRad);

  let azimuth = Math.atan2(
    sinHourAngle,
    cosHourAngle * sinLat - tanDec * cosLat
  );

  // Convert to degrees and normalize to 0-360
  azimuth = toDegrees(azimuth);
  azimuth = (azimuth + 180) % 360;

  return azimuth;
}

// Function to convert azimuth in degrees to compass direction
export function azimuthToCompassDirection(azimuth: number): string {
  // Define compass directions with their degree ranges
  const directions = [
    { name: "N", min: 348.75, max: 360 },
    { name: "N", min: 0, max: 11.25 },
    { name: "NNE", min: 11.25, max: 33.75 },
    { name: "NE", min: 33.75, max: 56.25 },
    { name: "ENE", min: 56.25, max: 78.75 },
    { name: "E", min: 78.75, max: 101.25 },
    { name: "ESE", min: 101.25, max: 123.75 },
    { name: "SE", min: 123.75, max: 146.25 },
    { name: "SSE", min: 146.25, max: 168.75 },
    { name: "S", min: 168.75, max: 191.25 },
    { name: "SSW", min: 191.25, max: 213.75 },
    { name: "SW", min: 213.75, max: 236.25 },
    { name: "WSW", min: 236.25, max: 258.75 },
    { name: "W", min: 258.75, max: 281.25 },
    { name: "WNW", min: 281.25, max: 303.75 },
    { name: "NW", min: 303.75, max: 326.25 },
    { name: "NNW", min: 326.25, max: 348.75 }
  ];

  // Find the matching direction
  for (const direction of directions) {
    if (direction.min <= azimuth && azimuth < direction.max) {
      return direction.name;
    }
  }

  // Default fallback (should never reach here if azimuth is normalized)
  return "N";
}

// Convert degrees to radians
export function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

// Convert radians to degrees
export function toDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}

// Get day of year (1-366)
export function getDayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  const oneDay = 1000 * 60 * 60 * 24;
  return Math.floor(diff / oneDay);
}

// Calculate local sidereal time
export function getSiderealTime(utcHours: number, dayOfYear: number, longitude: number): number {
  // Calculate GMST at 0h UT
  const d = dayOfYear + utcHours / 24.0;
  const T = (d / 36525) % 1; // Century fraction

  // Greenwich mean sidereal time (GMST) in hours
  let gmst = 6.697374558 + 0.06570982441908 * d + 1.00273790935 * utcHours + 0.000026 * T * T;

  // Normalize to range [0, 24)
  gmst = gmst % 24;
  if (gmst < 0) gmst += 24;

  // Convert to local sidereal time by adding the observer's longitude (in hours)
  let lst = gmst + longitude / 15.0;

  // Normalize to range [0, 24)
  lst = lst % 24;
  if (lst < 0) lst += 24;

  return lst;
}

/**
 * Calculate the angular distance between two celestial objects given their Alt/Az coordinates
 * Uses the spherical law of cosines
 * @returns Angular distance in degrees
 */
export function calculateAngularDistance(
  alt1: number,
  az1: number,
  alt2: number,
  az2: number
): number {
  const alt1Rad = toRadians(alt1);
  const alt2Rad = toRadians(alt2);
  const azDiffRad = toRadians(az2 - az1);

  const cosD = Math.sin(alt1Rad) * Math.sin(alt2Rad) +
               Math.cos(alt1Rad) * Math.cos(alt2Rad) * Math.cos(azDiffRad);

  // Clamp to valid range for acos due to floating point errors
  const clampedCosD = Math.max(-1, Math.min(1, cosD));
  const dRad = Math.acos(clampedCosD);

  return toDegrees(dRad);
}

/**
 * Get the current position of the moon (altitude and azimuth)
 * @returns Moon position in degrees
 */
export function getMoonPosition(coordinates: Coordinates): { altitude: number; azimuth: number } {
  const now = new Date();
  const moonPos = SunCalc.getMoonPosition(now, coordinates.latitude, coordinates.longitude);

  return {
    altitude: toDegrees(moonPos.altitude),
    azimuth: toDegrees(moonPos.azimuth) + 180 // SunCalc azimuth is measured from south, convert to north-based
  };
}

export type CelestialObjectType = "galaxy" | "nebula" | "cluster" | "planet" | "moon" | "double-star"

export const getObjectTypeIcon = (type: CelestialObjectType) => {
  switch (type) {
    case "galaxy":
      return <div className="w-3 h-3 rounded-full bg-purple-400"></div>
    case "nebula":
      return <div className="w-3 h-3 rounded-full bg-blue-400"></div>
    case "cluster":
      return <div className="w-3 h-3 rounded-full bg-yellow-400"></div>
    case "planet":
      return <div className="w-3 h-3 rounded-full bg-orange-400"></div>
    case "moon":
      return <div className="w-3 h-3 rounded-full bg-gray-400"></div>
    case "double-star":
      return <div className="w-3 h-3 rounded-full bg-red-400"></div>
    default:
      return <div className="w-3 h-3 rounded-full bg-white"></div>
  }
}
