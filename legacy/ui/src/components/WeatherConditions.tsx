"use client"

import {useEffect, useState} from "react"
import {Badge} from "@/components/ui/badge"
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card"
import {Cloud, Droplets, Eye, MapPin, RefreshCw, Wind, Plus, X, Search} from "lucide-react"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger} from "@/components/ui/dialog"

// Safe localStorage helpers for SSR
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

interface WeatherData {
  condition: string;
  temperature: number;
  humidity: number;
  windSpeed: number;
  windDirection: number;
  visibility: number;
  cloudCover: number;
  description: string;
}

interface ForecastData {
  dateTime: Date;
  transparency: number;
  seeing: number;
  isNight: boolean;
  cloudCover: number;
  humidity: number;
  windSpeed: number;
  temperature: number;
}

interface LocationData {
  latitude: number;
  longitude: number;
  city?: string;
  id: string;
  name: string;
  isCurrentLocation?: boolean;
}

type UnitSystem = 'metric' | 'imperial';

export function WeatherConditions() {
  const [weatherData, setWeatherData] = useState<Map<string, WeatherData>>(new Map())
  const [forecastData, setForecastData] = useState<Map<string, ForecastData[]>>(new Map())
  const [locations, setLocations] = useState<LocationData[]>([])
  const [activeLocationId, setActiveLocationId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<LocationData[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [units, setUnits] = useState<UnitSystem>('metric')
  const [unitsLoaded, setUnitsLoaded] = useState(false)

  // Load units from localStorage on mount
  useEffect(() => {
    const savedUnits = safeGetItem('weatherUnits') as UnitSystem
    if (savedUnits === 'metric' || savedUnits === 'imperial') {
      setUnits(savedUnits)
    }
    setUnitsLoaded(true)
  }, [])

  // Update weather when units change (but not on initial load)
  useEffect(() => {
    if (locations.length > 0 && unitsLoaded) {
      locations.forEach(location => {
        fetchWeatherDataForLocation(location, units)
      })
    }
  }, [units, unitsLoaded])

  const toggleUnits = () => {
    const newUnits = units === 'metric' ? 'imperial' : 'metric'
    setUnits(newUnits)
    safeSetItem('weatherUnits', newUnits)
  }

  const getTemperatureUnit = () => units === 'metric' ? '°C' : '°F'
  const getSpeedUnit = () => units === 'metric' ? 'm/s' : 'mph'
  const getDistanceUnit = () => units === 'metric' ? 'km' : 'mi'

  const getSeeingCondition = (visibility: number, cloudCover: number, windSpeed: number) => {
    // Calculate seeing based on visibility, cloud cover, and wind
    const visibilityScore = Math.min(visibility / 10, 1) // Normalize to 0-1
    const cloudScore = (100 - cloudCover) / 100 // Invert cloud cover
    const windScore = Math.max(0, (15 - windSpeed) / 15) // Less wind is better

    const overallScore = (visibilityScore + cloudScore + windScore) / 3

    if (overallScore > 0.8) return { condition: "Excellent", value: 1.2 }
    if (overallScore > 0.6) return { condition: "Good", value: 1.8 }
    if (overallScore > 0.4) return { condition: "Fair", value: 2.5 }
    return { condition: "Poor", value: 3.5 }
  }

  const calculateAstronomicalConditions = (cloudCover: number, humidity: number, windSpeed: number) => {
    // Calculate transparency (0-100%) - less clouds and humidity = better transparency
    const cloudScore = (100 - cloudCover) / 100
    const humidityScore = Math.max(0, (80 - humidity) / 80) // High humidity reduces transparency
    const transparency = Math.round((cloudScore * 0.7 + humidityScore * 0.3) * 100)

    // Calculate seeing (arcseconds) - less wind and turbulence = better seeing
    const windScore = Math.max(0, (20 - windSpeed) / 20)
    const seeing = 1.0 + (1 - windScore) * 3.0 // Range from 1.0 to 4.0 arcseconds

    return { transparency: Math.max(20, transparency), seeing: Number(seeing.toFixed(1)) }
  }

  const searchLocation = async (query: string) => {
    if (!query.trim()) return

    setIsSearching(true)
    setSearchResults([])

    try {
      const apiKey = process.env.NEXT_PUBLIC_OPENWEATHER_API_KEY
      if (!apiKey) {
        throw new Error('Weather API key not configured')
      }

      const response = await fetch(
        `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(query)}&limit=5&appid=${apiKey}`
      )

      if (!response.ok) {
        throw new Error('Failed to search locations')
      }

      const data = await response.json()
      const results: LocationData[] = data.map((item: any) => ({
        id: `search-${item.lat}-${item.lon}`,
        name: `${item.name}${item.state ? `, ${item.state}` : ''}, ${item.country}`,
        latitude: item.lat,
        longitude: item.lon,
        city: item.name,
        isCurrentLocation: false
      }))

      setSearchResults(results)
    } catch (err) {
      console.error('Location search error:', err)
      setSearchResults([])
    } finally {
      setIsSearching(false)
    }
  }

  const addLocation = async (location: LocationData) => {
    // Check if location already exists
    const exists = locations.some(loc => 
      Math.abs(loc.latitude - location.latitude) < 0.01 && 
      Math.abs(loc.longitude - location.longitude) < 0.01
    )
    
    if (exists) {
      setSearchOpen(false)
      return
    }

    const newLocation = {
      ...location,
      id: `loc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    }

    const updatedLocations = [...locations, newLocation]
    setLocations(updatedLocations)
    
    // Set as active if first location
    if (!activeLocationId) {
      setActiveLocationId(newLocation.id)
    }

    // Save to localStorage
    safeSetItem('weatherLocations', JSON.stringify(updatedLocations))

    // Fetch weather data for new location
    await fetchWeatherDataForLocation(newLocation, units)

    setSearchOpen(false)
    setSearchQuery('')
    setSearchResults([])
  }

  const removeLocation = (locationId: string) => {
    const updatedLocations = locations.filter(loc => loc.id !== locationId)
    setLocations(updatedLocations)
    
    // Update active location if removed
    if (activeLocationId === locationId) {
      setActiveLocationId(updatedLocations.length > 0 ? updatedLocations[0].id : null)
    }
    
    // Remove weather data
    const newWeatherData = new Map(weatherData)
    const newForecastData = new Map(forecastData)
    newWeatherData.delete(locationId)
    newForecastData.delete(locationId)
    setWeatherData(newWeatherData)
    setForecastData(newForecastData)
    
    // Save to localStorage
    safeSetItem('weatherLocations', JSON.stringify(updatedLocations))
  }

  const fetchForecastDataForLocation = async (location: LocationData, unitSystem: UnitSystem = units) => {
    try {
      const apiKey = process.env.NEXT_PUBLIC_OPENWEATHER_API_KEY
      if (!apiKey) {
        console.error('Weather API key not configured')
        return
      }

      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/forecast?lat=${location.latitude}&lon=${location.longitude}&appid=${apiKey}&units=${unitSystem}`
      )

      if (!response.ok) {
        throw new Error('Failed to fetch forecast data')
      }

      const data = await response.json()

      // Take the next 16 3-hour intervals (48 hours)
      const forecast: ForecastData[] = data.list
        .slice(0, 16)
        .map((item: any) => {
          const dateTime = new Date(item.dt * 1000)
          const hour = dateTime.getHours()

          const cloudCover = item.clouds.all
          const humidity = item.main.humidity
          const windSpeed = item.wind.speed
          const temperature = item.main.temp

          const conditions = calculateAstronomicalConditions(cloudCover, humidity, windSpeed)

          // Determine if it's night time (simplified - could use sunrise/sunset API)
          const isNight = hour < 6 || hour > 20

          return {
            dateTime,
            transparency: conditions.transparency,
            seeing: conditions.seeing,
            isNight,
            cloudCover,
            humidity,
            windSpeed,
            temperature
          }
        })

      setForecastData(prev => new Map(prev.set(location.id, forecast)))
    } catch (err) {
      console.error('Forecast fetch error:', err)
      // Fallback to mock data if API fails
      const mockForecast: ForecastData[] = []
      for (let i = 0; i < 16; i++) {
        const dateTime = new Date()
        dateTime.setHours(dateTime.getHours() + (i * 3))
        const hour = dateTime.getHours()

        const conditions = calculateAstronomicalConditions(
          Math.random() * 80, // Random cloud cover
          40 + Math.random() * 40, // Random humidity 40-80%
          Math.random() * 15 // Random wind speed
        )
        mockForecast.push({
          dateTime,
          transparency: conditions.transparency,
          seeing: conditions.seeing,
          isNight: hour < 6 || hour > 20,
          cloudCover: Math.round(Math.random() * 80),
          humidity: Math.round(40 + Math.random() * 40),
          windSpeed: Math.random() * 15,
          temperature: 10 + Math.random() * 20
        })
      }
      setForecastData(prev => new Map(prev.set(location.id, mockForecast)))
    }
  }

  const fetchWeatherDataForLocation = async (location: LocationData, unitSystem: UnitSystem = units) => {
    try {
      // Using OpenWeatherMap API (you'll need to add NEXT_PUBLIC_OPENWEATHER_API_KEY to your .env)
      const apiKey = process.env.NEXT_PUBLIC_OPENWEATHER_API_KEY
      if (!apiKey) {
        throw new Error('Weather API key not configured')
      }

      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?lat=${location.latitude}&lon=${location.longitude}&appid=${apiKey}&units=${unitSystem}`
      )

      if (!response.ok) {
        throw new Error('Failed to fetch weather data')
      }

      const data = await response.json()

      const weather: WeatherData = {
        condition: data.weather[0].main.toLowerCase(),
        temperature: Math.round(data.main.temp),
        humidity: data.main.humidity,
        windSpeed: data.wind.speed,
        windDirection: data.wind.deg || 0,
        visibility: (data.visibility || 10000) / 1000, // Convert to km
        cloudCover: data.clouds.all,
        description: data.weather[0].description
      }

      setWeatherData(prev => new Map(prev.set(location.id, weather)))
      // Also fetch forecast data
      await fetchForecastDataForLocation(location, unitSystem)
    } catch (err) {
      console.error('Weather fetch error:', err)

      // Fallback to mock data
      const mockWeather: WeatherData = {
        condition: 'clear',
        temperature: unitSystem === 'metric' ? 15 : 59,
        humidity: 45,
        windSpeed: unitSystem === 'metric' ? 8.2 : 18.3,
        windDirection: 180,
        visibility: unitSystem === 'metric' ? 10 : 6.2,
        cloudCover: 20,
        description: 'clear sky'
      }
      setWeatherData(prev => new Map(prev.set(location.id, mockWeather)))
    }
  }

  const getCityName = async (lat: number, lon: number): Promise<string> => {
    try {
      const response = await fetch(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`
      )
      if (response.ok) {
        const data = await response.json()
        return data.city || data.locality || data.principalSubdivision || 'Unknown'
      }
    } catch (err) {
      console.error('Reverse geocoding error:', err)
    }
    return 'Current Location'
  }

  const getCurrentLocation = async () => {
    if (!navigator.geolocation) {
      setError('Geolocation is not supported by this browser')
      setIsLoading(false)
      return
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const cityName = await getCityName(position.coords.latitude, position.coords.longitude)
          
          const newLocation: LocationData = {
            id: 'current-location',
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            name: cityName,
            city: cityName,
            isCurrentLocation: true
          }

          // Check if current location already exists, if so update it
          const existingLocations = locations.filter(loc => !loc.isCurrentLocation)
          const updatedLocations = [newLocation, ...existingLocations]
          
          setLocations(updatedLocations)
          setActiveLocationId(newLocation.id)
          
          // Save to localStorage
          safeSetItem('weatherLocations', JSON.stringify(updatedLocations))

          await fetchWeatherDataForLocation(newLocation, units)
        } catch (err) {
          console.error('Error processing current location:', err)
          setError('Unable to process your location')
        }
      },
      (error) => {
        console.error('Geolocation error:', error)
        setError('Unable to get your location')
        setIsLoading(false)
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 300000 // 5 minutes
      }
    )
  }

  useEffect(() => {
    const initializeLocations = async () => {
      setIsLoading(true)
      setError(null)
      
      // Try to load saved locations first
      const savedLocations = safeGetItem('weatherLocations')
      if (savedLocations === null && typeof window === 'undefined') {
        setIsLoading(false)
        return
      }
      if (savedLocations) {
        try {
          const parsed: LocationData[] = JSON.parse(savedLocations)
          if (parsed.length > 0) {
            setLocations(parsed)
            setActiveLocationId(parsed[0].id)
            
            // Fetch weather data for all saved locations
            for (const location of parsed) {
              await fetchWeatherDataForLocation(location, units)
            }
            setIsLoading(false)
            return
          }
        } catch (err) {
          console.error('Error parsing saved locations:', err)
        }
      }

      // If no saved locations, get current location
      await getCurrentLocation()
      setIsLoading(false)
    }

    initializeLocations()
  }, [])

  const refreshWeather = async () => {
    if (activeLocationId) {
      const activeLocation = locations.find(loc => loc.id === activeLocationId)
      if (activeLocation) {
        await fetchWeatherDataForLocation(activeLocation, units)
      }
    } else if (locations.length > 0) {
      for (const location of locations) {
        await fetchWeatherDataForLocation(location, units)
      }
    } else {
      await getCurrentLocation()
    }
  }

  // Get active location data
  const activeLocation = activeLocationId ? locations.find(loc => loc.id === activeLocationId) : null
  const weather = activeLocationId ? weatherData.get(activeLocationId) : null
  const forecast = activeLocationId ? forecastData.get(activeLocationId) || [] : []

  if (isLoading && locations.length === 0) {
    return (
      <Card className="bg-gray-800 border-gray-700">
        <CardHeader>
          <CardTitle className="text-white text-lg flex items-center gap-2">
            <Cloud className="w-5 h-5" />
            Weather Conditions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-4">
            <RefreshCw className="w-5 h-5 animate-spin text-gray-400" />
            <span className="ml-2 text-gray-400">Loading weather...</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error && locations.length === 0) {
    return (
      <Card className="bg-gray-800 border-gray-700">
        <CardHeader>
          <CardTitle className="text-white text-lg flex items-center gap-2">
            <Cloud className="w-5 h-5" />
            Weather Conditions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4">
            <p className="text-gray-400 mb-2">{error}</p>
            <Button variant="outline" size="sm" onClick={refreshWeather}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const seeingData = weather ? getSeeingCondition(weather.visibility, weather.cloudCover, weather.windSpeed) : null

  return (
    <Card className="bg-gray-800 border-gray-700">
      <CardHeader>
        <CardTitle className="text-white text-lg flex items-center gap-2">
          <Cloud className="w-5 h-5" />
          Weather Conditions
          <div className="ml-auto flex items-center gap-1">
            <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  title="Add location"
                  onClick={() => setSearchOpen(true)}
                >
                  <Plus className="w-3 h-3" />
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-gray-800 border-gray-700">
                <DialogHeader>
                  <DialogTitle className="text-white">Add Weather Location</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Search for a city..."
                      value={searchQuery}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                      onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === 'Enter' && searchQuery.trim()) {
                          searchLocation(searchQuery)
                        }
                      }}
                      className="bg-gray-700 border-gray-600 text-white"
                    />
                    <Button
                      onClick={() => searchLocation(searchQuery)}
                      disabled={!searchQuery.trim() || isSearching}
                      className="bg-blue-600 hover:bg-blue-700"
                    >
                      {isSearching ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                    </Button>
                  </div>
                  
                  <Button
                    onClick={getCurrentLocation}
                    variant="outline"
                    className="w-full border-gray-600 text-gray-300 hover:text-white"
                  >
                    <MapPin className="w-4 h-4 mr-2" />
                    Use Current Location
                  </Button>

                  {searchResults.length > 0 && (
                    <div className="space-y-2 max-h-60 overflow-y-auto">
                      {searchResults.map((result) => (
                        <Button
                          key={result.id}
                          variant="ghost"
                          className="w-full justify-start text-left text-gray-300 hover:text-white hover:bg-gray-700"
                          onClick={() => addLocation(result)}
                        >
                          <MapPin className="w-4 h-4 mr-2" />
                          {result.name}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              </DialogContent>
            </Dialog>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleUnits}
              className="h-6 px-2 text-xs"
              title={`Switch to ${units === 'metric' ? 'Imperial' : 'Metric'}`}
            >
              {units === 'metric' ? '°C' : '°F'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={refreshWeather}
              className="h-6 w-6 p-0"
              title="Refresh weather data"
            >
              <RefreshCw className="w-3 h-3" />
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Location Tabs */}
        {locations.length > 1 && (
          <div className="flex gap-1 overflow-x-auto pb-2">
            {locations.map((location) => (
              <Button
                key={location.id}
                variant={activeLocationId === location.id ? "default" : "ghost"}
                size="sm"
                onClick={() => setActiveLocationId(location.id)}
                className={`text-xs whitespace-nowrap flex items-center gap-1 ${
                  activeLocationId === location.id 
                    ? "bg-blue-600 text-white" 
                    : "text-gray-400 hover:text-white"
                }`}
              >
                {location.isCurrentLocation && <MapPin className="w-3 h-3" />}
                {location.name}
                {locations.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                      e.stopPropagation()
                      removeLocation(location.id)
                    }}
                    className="h-4 w-4 p-0 ml-1 hover:bg-red-600"
                  >
                    <X className="w-2 h-2" />
                  </Button>
                )}
              </Button>
            ))}
          </div>
        )}

        {activeLocation && (
          <div className="flex items-center gap-1 text-xs text-gray-400 mb-2">
            <MapPin className="w-3 h-3" />
            <span>{activeLocation.latitude.toFixed(2)}, {activeLocation.longitude.toFixed(2)}</span>
          </div>
        )}

        {weather ? (
          <>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="flex items-center gap-2">
                <Cloud className="w-4 h-4 text-blue-400" />
                <div>
                  <div className="text-gray-300">Sky</div>
                  <div className="text-white font-medium capitalize">{weather.description}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Droplets className="w-4 h-4 text-blue-400" />
                <div>
                  <div className="text-gray-300">Humidity</div>
                  <div className="text-white font-medium">{weather.humidity}%</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Wind className="w-4 h-4 text-gray-400" />
                <div>
                  <div className="text-gray-300">Wind</div>
                  <div className="text-white font-medium">{weather.windSpeed.toFixed(1)} {getSpeedUnit()}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Eye className="w-4 h-4 text-green-400" />
                <div>
                  <div className="text-gray-300">Seeing</div>
                  <div className="text-white font-medium">
                    {seeingData?.condition}
                    <span className="text-xs text-gray-400 ml-1">({seeingData?.value.toFixed(1)}")</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-gray-300">Temperature</div>
                <div className="text-white font-medium">{Math.round(weather.temperature)}{getTemperatureUnit()}</div>
              </div>
              <div>
                <div className="text-gray-300">Visibility</div>
                <div className="text-white font-medium">{weather.visibility.toFixed(1)} {getDistanceUnit()}</div>
              </div>
            </div>
          </>
        ) : (
          <div className="text-center py-4 text-gray-400">
            <RefreshCw className="w-4 h-4 mx-auto mb-2 animate-spin" />
            Loading weather data...
          </div>
        )}

        <div className="pt-4 border-t border-gray-700">
          <h4 className="text-sm font-medium mb-3">48-Hour Forecast (3-Hour Intervals)</h4>

          {forecast.length > 0 ? (
            <>
              {/* Time labels */}
              <div className="overflow-x-auto">
                <div className="flex gap-1 mb-2 text-xs min-w-max">
                  <div className="w-16 flex-shrink-0"></div>
                  {forecast.map((data, index) => {
                    // Only show labels every 4th interval (12 hours) or first/last
                    const shouldShowLabel = index === 0 || index === forecast.length - 1 || index % 4 === 0
                    const timeStr = data.dateTime.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit'
                    }).replace(',', '')

                    return (
                      <div key={index} className="w-4 flex-shrink-0 text-center text-gray-400 font-medium text-xs transform -rotate-45 origin-center h-8 flex items-end justify-center">
                        {shouldShowLabel ? <span className="text-xs">{timeStr}</span> : ''}
                      </div>
                    )
                  })}
                </div>

                {/* Sky Transparency Row */}
                <div className="flex gap-1 mb-2 min-w-max">
                  <div className="w-16 flex-shrink-0 text-xs text-gray-300 flex items-center">Transparency</div>
                  {forecast.map((data, index) => {
                    const getTransparencyColor = (value: number) => {
                      if (value >= 80) return 'bg-green-500'
                      if (value >= 60) return 'bg-yellow-500'
                      if (value >= 40) return 'bg-orange-500'
                      return 'bg-red-500'
                    }

                    return (
                      <div
                        key={index}
                        className={`w-4 h-4 flex-shrink-0 rounded cursor-pointer ${getTransparencyColor(data.transparency)}`}
                        title={`${data.dateTime.toLocaleString()}\nTransparency: ${data.transparency}%\nCloud: ${data.cloudCover}%\nHumidity: ${data.humidity}%`}
                      >
                      </div>
                    )
                  })}
                </div>

                {/* Seeing Row */}
                <div className="flex gap-1 mb-2 min-w-max">
                  <div className="w-16 flex-shrink-0 text-xs text-gray-300 flex items-center">Seeing</div>
                  {forecast.map((data, index) => {
                    const getSeeingColor = (value: number) => {
                      if (value <= 1.5) return 'bg-green-500'
                      if (value <= 2.5) return 'bg-yellow-500'
                      if (value <= 3.5) return 'bg-orange-500'
                      return 'bg-red-500'
                    }

                    return (
                      <div
                        key={index}
                        className={`w-4 h-4 flex-shrink-0 rounded cursor-pointer ${getSeeingColor(data.seeing)}`}
                        title={`${data.dateTime.toLocaleString()}\nSeeing: ${data.seeing}" arcsec\nWind: ${data.windSpeed.toFixed(1)} ${getSpeedUnit()}`}
                      >
                      </div>
                    )
                  })}
                </div>

                {/* Day/Night indicator */}
                <div className="flex gap-1 mb-2 min-w-max">
                  <div className="w-16 flex-shrink-0 text-xs text-gray-300 flex items-center">Day/Night</div>
                  {forecast.map((data, index) => (
                    <div
                      key={index}
                      className={`w-4 h-3 flex-shrink-0 rounded cursor-pointer flex items-center justify-center ${data.isNight ? 'bg-gray-900 border border-gray-600' : 'bg-yellow-200'}`}
                      title={`${data.dateTime.toLocaleString()}\n${data.isNight ? 'Night time' : 'Day time'}\nTemp: ${Math.round(data.temperature)}${getTemperatureUnit()}`}
                    >
                      <div className={`w-1.5 h-1.5 rounded-full ${data.isNight ? 'bg-gray-300' : 'bg-yellow-600'}`}></div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-4 text-gray-400">
              <RefreshCw className="w-4 h-4 mx-auto mb-2 animate-spin" />
              Loading forecast data...
            </div>
          )}

          {/* Legend */}
          <div className="mt-3 pt-2 border-t border-gray-600">
            <div className="text-xs text-gray-400 mb-1">Legend:</div>
            <div className="flex flex-wrap gap-2 text-xs">
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 bg-green-500 rounded"></div>
                <span className="text-gray-300">Excellent</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 bg-yellow-500 rounded"></div>
                <span className="text-gray-300">Good</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 bg-orange-500 rounded"></div>
                <span className="text-gray-300">Fair</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 bg-red-500 rounded"></div>
                <span className="text-gray-300">Poor</span>
              </div>
            </div>
          </div>
        </div>

        {/* Weather Status Indicator */}
        {weather && seeingData && (
          <div className="pt-2 border-t border-gray-700">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-300">Observing Conditions</span>
              <Badge
                variant={
                  seeingData.condition === "Excellent" || seeingData.condition === "Good"
                    ? "default"
                    : seeingData.condition === "Fair"
                      ? "secondary"
                      : "destructive"
                }
              >
                {seeingData.condition === "Excellent" || seeingData.condition === "Good"
                  ? "Optimal"
                  : seeingData.condition === "Fair"
                    ? "Moderate"
                    : "Poor"}
              </Badge>
            </div>
            <div className="text-xs text-gray-400 mt-1">
              Cloud cover: {weather.cloudCover}%
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
