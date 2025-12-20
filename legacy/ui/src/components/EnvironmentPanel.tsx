"use client"

import {Badge} from "@/components/ui/badge"
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card"
import {Separator} from "@/components/ui/separator"
import {Cloud, Droplets, Eye, Moon, Wind} from "lucide-react"

type Weather = {
  condition: string
  humidity: number
  windSpeed: number
  seeingCondition: string
  seeingValue: number // arcseconds
}
type Moon = {
  phase: string
  illumination: number
  age: number // days since new moon
  rise: string
  set: string
  isVisible: boolean
}

export function EnvironmentPanel() {
  // Extract weather data for cleaner access
  const weather: Weather = {
    condition: 'clear',
    humidity: 45,
    windSpeed: 8.2,
    seeingCondition: "Good",
    seeingValue: 2.1, // arcseconds
  }

  // Extract moon data for cleaner access
  const moon: Moon = {
    phase: "Waxing Gibbous",
    illumination: 78.5,
    age: 10.2, // days since new moon
    rise: "18:45",
    set: "06:23",
    isVisible: true,
  }

  return (
    <Card className="bg-gray-800 border-gray-700">
      <CardHeader>
        <CardTitle className="text-white text-lg flex items-center gap-2">
          <Cloud className="w-5 h-5" />
          Environmental Conditions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Weather Conditions */}
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-gray-300">Current Weather</h4>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="flex items-center gap-2">
              <Cloud className="w-4 h-4 text-blue-400" />
              <div>
                <div className="text-gray-300">Sky</div>
                <div className="text-white font-medium">{weather.condition}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Droplets className="w-4 h-4 text-blue-400" />
              <div>
                <div className="text-gray-300">Humidity</div>
                <div className="text-white font-medium">{Math.round(weather.humidity)}%</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Wind className="w-4 h-4 text-gray-400" />
              <div>
                <div className="text-gray-300">Wind</div>
                <div className="text-white font-medium">{weather.windSpeed.toFixed(1)} m/s</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-green-400" />
              <div>
                <div className="text-gray-300">Seeing</div>
                <div className="text-white font-medium">
                  {weather.seeingCondition}
                  <span className="text-xs text-gray-400 ml-1">({weather.seeingValue.toFixed(1)})</span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-300">Observing Conditions</span>
            <Badge
              variant={
                weather.seeingCondition === "Excellent" || weather.seeingCondition === "Good"
                  ? "default"
                  : weather.seeingCondition === "Fair"
                    ? "secondary"
                    : "destructive"
              }
            >
              {weather.seeingCondition === "Excellent" || weather.seeingCondition === "Good"
                ? "Optimal"
                : weather.seeingCondition === "Fair"
                  ? "Moderate"
                  : "Poor"}
            </Badge>
          </div>
        </div>

        <Separator className="bg-gray-700" />

        {/* Moon Phase */}
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
            <Moon className="w-4 h-4" />
            Moon Phase
          </h4>

          <div className="flex items-center justify-center">
            <div className="relative w-16 h-16 bg-gray-700 rounded-full overflow-hidden">
              <div className="absolute inset-0 bg-gray-300 rounded-full"></div>
              <div
                className="absolute inset-0 bg-gray-700 rounded-full transition-all duration-1000"
                style={{
                  clipPath:
                    moon.illumination > 50
                      ? `inset(0 ${100 - moon.illumination}% 0 0)`
                      : `inset(0 0 0 ${moon.illumination}%)`,
                }}
              ></div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="text-center">
              <div className="text-gray-300">Phase</div>
              <div className="text-white font-medium">{moon.phase}</div>
            </div>
            <div className="text-center">
              <div className="text-gray-300">Illumination</div>
              <div className="text-white font-medium">{Math.round(moon.illumination)}%</div>
            </div>
            <div className="text-center">
              <div className="text-gray-300">Age</div>
              <div className="text-white font-medium">{moon.age.toFixed(1)} days</div>
            </div>
            <div className="text-center">
              <div className="text-gray-300">Visible</div>
              <Badge variant={moon.isVisible ? "default" : "secondary"}>
                {moon.isVisible ? "Yes" : "No"}
              </Badge>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="text-center">
              <div className="text-gray-300">Moonrise</div>
              <div className="text-white font-medium">{moon.rise}</div>
            </div>
            <div className="text-center">
              <div className="text-gray-300">Moonset</div>
              <div className="text-white font-medium">{moon.set}</div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-300">Light Pollution</span>
            <Badge
              variant={
                moon.illumination < 25
                  ? "default"
                  : moon.illumination < 75
                    ? "secondary"
                    : "destructive"
              }
            >
              {moon.illumination < 25
                ? "Minimal"
                : moon.illumination < 75
                  ? "Moderate"
                  : "High"}
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
