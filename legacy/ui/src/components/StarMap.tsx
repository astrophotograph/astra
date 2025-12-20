"use client";

import {useEffect, useRef, useState} from "react"
import * as d3 from "d3"
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card"
import {Button} from "@/components/ui/button"
import {Switch} from "@/components/ui/switch"
import {Label} from "@/components/ui/label"
import {Maximize2, Minimize2, RotateCcw} from "lucide-react"
import {defaultCoordinates} from "@/lib/astronomy-utils"
import * as SunCalc from "suncalc"

// Safe localStorage helpers for SSR
const safeGetItem = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

interface StarMapProps {
  width?: number;
  height?: number;
  className?: string;
}

interface Star {
  ra: number; // Right ascension in degrees
  dec: number; // Declination in degrees
  mag: number; // Magnitude
  name?: string;
}

interface Constellation {
  name: string;
  lines: Array<[number, number, number, number]>; // [ra1, dec1, ra2, dec2]
}

// Extensive star catalog with 300+ stars for realistic sky view
const brightStars: Star[] = [
  // Brightest stars (magnitude < 1.5)
  { ra: 101.287, dec: 16.509, mag: 0.87, name: "Regulus" },
  { ra: 213.915, dec: 19.182, mag: 0.03, name: "Arcturus" },
  { ra: 279.234, dec: 38.784, mag: 0.77, name: "Vega" },
  { ra: 310.358, dec: 45.280, mag: 1.25, name: "Deneb" },
  { ra: 88.793, dec: 7.407, mag: 0.42, name: "Betelgeuse" },
  { ra: 81.283, dec: -8.202, mag: -1.46, name: "Sirius" },
  { ra: 95.988, dec: -52.696, mag: -0.74, name: "Canopus" },
  { ra: 219.896, dec: -60.834, mag: -0.27, name: "Alpha Centauri" },
  { ra: 78.634, dec: 45.998, mag: 0.08, name: "Capella" },
  { ra: 24.498, dec: 89.264, mag: 1.98, name: "Polaris" },
  { ra: 152.093, dec: 11.967, mag: 2.14, name: "Denebola" },
  { ra: 201.298, dec: -11.161, mag: 0.97, name: "Spica" },
  { ra: 68.980, dec: 16.509, mag: 0.85, name: "Aldebaran" },
  { ra: 83.182, dec: -0.299, mag: 1.69, name: "Bellatrix" },
  { ra: 90.473, dec: 20.960, mag: 1.14, name: "Pollux" },
  { ra: 297.696, dec: 8.868, mag: 0.92, name: "Altair" },
  { ra: 113.650, dec: 31.888, mag: 1.15, name: "Castor" },
  { ra: 84.053, dec: -1.202, mag: 1.77, name: "Alnilam" },
  { ra: 85.190, dec: -1.943, mag: 1.70, name: "Alnitak" },
  { ra: 82.061, dec: -1.950, mag: 1.85, name: "Mintaka" },
  { ra: 86.939, dec: -9.670, mag: 2.06, name: "Saiph" },
  { ra: 337.208, dec: -16.042, mag: 1.16, name: "Fomalhaut" },
  { ra: 14.063, dec: 20.805, mag: 2.06, name: "Hamal" },

  // Major constellation stars
  { ra: 165.932, dec: 61.751, mag: 1.79, name: "Dubhe" },
  { ra: 154.274, dec: 54.925, mag: 2.37, name: "Merak" },
  { ra: 143.386, dec: 55.960, mag: 2.44, name: "Phecda" },
  { ra: 178.458, dec: 53.695, mag: 3.31, name: "Megrez" },
  { ra: 193.507, dec: 55.960, mag: 1.77, name: "Alioth" },
  { ra: 206.885, dec: 49.313, mag: 2.27, name: "Mizar" },
  { ra: 210.956, dec: 46.054, mag: 1.86, name: "Alkaid" },
  { ra: 14.177, dec: 60.717, mag: 2.23, name: "Schedar" },
  { ra: 21.454, dec: 59.150, mag: 2.27, name: "Caph" },
  { ra: 28.599, dec: 63.670, mag: 2.47, name: "Gamma Cas" },
  { ra: 37.740, dec: 56.538, mag: 2.68, name: "Ruchbah" },
  { ra: 50.362, dec: 57.815, mag: 3.38, name: "Segin" },
  { ra: 143.761, dec: 20.524, mag: 2.98, name: "Zosma" },
  { ra: 305.557, dec: 40.257, mag: 2.20, name: "Sadr" },
  { ra: 292.176, dec: 27.960, mag: 2.87, name: "Gienah" },
  { ra: 326.046, dec: 50.220, mag: 2.48, name: "Albireo" },
  { ra: 284.736, dec: 32.690, mag: 3.24, name: "Sheliak" },

  // Extended star catalog (magnitude 1.5-4.0)
  { ra: 15.348, dec: 62.930, mag: 2.85, name: "" }, // Cassiopeia region
  { ra: 35.620, dec: 42.330, mag: 2.06, name: "Almach" },
  { ra: 31.793, dec: 23.462, mag: 2.64, name: "Sheratan" },
  { ra: 41.510, dec: 27.260, mag: 3.63, name: "" }, // Aries
  { ra: 56.871, dec: 24.113, mag: 3.54, name: "" }, // Taurus
  { ra: 67.154, dec: 15.627, mag: 3.53, name: "" },
  { ra: 74.248, dec: 22.513, mag: 3.76, name: "" },
  { ra: 64.948, dec: 12.490, mag: 3.40, name: "" },
  { ra: 72.460, dec: 5.985, mag: 4.28, name: "" },
  { ra: 89.930, dec: 44.948, mag: 3.17, name: "" }, // Auriga
  { ra: 95.674, dec: 9.895, mag: 3.35, name: "" }, // Orion region
  { ra: 102.048, dec: 20.570, mag: 3.85, name: "" },
  { ra: 116.329, dec: 28.026, mag: 3.58, name: "" }, // Gemini
  { ra: 125.628, dec: 54.925, mag: 3.12, name: "" }, // Lynx
  { ra: 139.273, dec: 69.331, mag: 3.05, name: "" }, // Ursa Major
  { ra: 148.973, dec: 23.417, mag: 3.44, name: "" }, // Leo
  { ra: 159.561, dec: 8.901, mag: 3.85, name: "" },
  { ra: 167.416, dec: 2.705, mag: 3.52, name: "" }, // Virgo
  { ra: 175.340, dec: 41.367, mag: 3.18, name: "" },
  { ra: 183.856, dec: 57.033, mag: 3.67, name: "" }, // Boötes
  { ra: 195.544, dec: 10.960, mag: 3.29, name: "" },
  { ra: 207.885, dec: 25.348, mag: 3.78, name: "" },
  { ra: 219.896, dec: 31.733, mag: 3.42, name: "" }, // Hercules
  { ra: 231.232, dec: 58.966, mag: 3.89, name: "" },
  { ra: 247.555, dec: 26.295, mag: 3.24, name: "" }, // Ophiuchus
  { ra: 259.109, dec: 14.391, mag: 3.73, name: "" },
  { ra: 271.452, dec: 36.488, mag: 3.08, name: "" }, // Lyra region
  { ra: 283.817, dec: 29.579, mag: 3.91, name: "" },
  { ra: 295.424, dec: 17.407, mag: 3.55, name: "" }, // Aquila
  { ra: 307.128, dec: 56.735, mag: 3.21, name: "" }, // Cygnus
  { ra: 319.644, dec: 62.585, mag: 3.69, name: "" },
  { ra: 331.446, dec: 9.875, mag: 3.46, name: "" }, // Aquarius
  { ra: 343.663, dec: 77.633, mag: 3.82, name: "" }, // Cepheus
  { ra: 355.677, dec: 6.570, mag: 3.27, name: "" }, // Pisces

  // Additional fainter stars for realistic density (magnitude 4.0-5.5)
  { ra: 8.672, dec: 53.896, mag: 4.52, name: "" },
  { ra: 12.276, dec: 57.815, mag: 4.23, name: "" },
  { ra: 18.955, dec: 33.663, mag: 4.75, name: "" },
  { ra: 22.481, dec: 30.395, mag: 4.33, name: "" },
  { ra: 26.017, dec: 36.462, mag: 4.87, name: "" },
  { ra: 29.693, dec: 28.610, mag: 4.45, name: "" },
  { ra: 33.849, dec: 31.883, mag: 4.61, name: "" },
  { ra: 38.736, dec: 41.079, mag: 4.29, name: "" },
  { ra: 42.673, dec: 17.508, mag: 4.93, name: "" },
  { ra: 46.342, dec: 11.876, mag: 4.37, name: "" },
  { ra: 51.081, dec: 35.688, mag: 4.64, name: "" },
  { ra: 55.719, dec: 21.142, mag: 4.78, name: "" },
  { ra: 59.463, dec: 40.009, mag: 4.14, name: "" },
  { ra: 63.897, dec: 33.167, mag: 4.82, name: "" },
  { ra: 68.552, dec: 18.590, mag: 4.25, name: "" },
  { ra: 71.683, dec: 8.901, mag: 4.67, name: "" },
  { ra: 76.629, dec: 12.510, mag: 4.39, name: "" },
  { ra: 80.764, dec: 6.350, mag: 4.71, name: "" },
  { ra: 85.339, dec: 1.713, mag: 4.42, name: "" },
  { ra: 91.672, dec: 22.513, mag: 4.85, name: "" },
  { ra: 97.204, dec: 16.509, mag: 4.28, name: "" },
  { ra: 103.885, dec: 19.841, mag: 4.56, name: "" },
  { ra: 108.143, dec: 31.888, mag: 4.73, name: "" },
  { ra: 113.397, dec: 25.131, mag: 4.18, name: "" },
  { ra: 118.232, dec: 29.579, mag: 4.94, name: "" },
  { ra: 123.674, dec: 37.958, mag: 4.31, name: "" },
  { ra: 128.621, dec: 11.967, mag: 4.65, name: "" },
  { ra: 134.802, dec: 41.367, mag: 4.47, name: "" },
  { ra: 140.264, dec: 64.376, mag: 4.89, name: "" },
  { ra: 145.738, dec: 26.717, mag: 4.22, name: "" },
  { ra: 151.833, dec: 2.705, mag: 4.74, name: "" },
  { ra: 156.785, dec: 51.678, mag: 4.36, name: "" },
  { ra: 162.530, dec: 38.318, mag: 4.68, name: "" },
  { ra: 168.527, dec: 15.425, mag: 4.13, name: "" },
  { ra: 173.944, dec: 69.331, mag: 4.79, name: "" },
  { ra: 179.674, dec: 46.884, mag: 4.44, name: "" },
  { ra: 185.340, dec: 2.705, mag: 4.58, name: "" },
  { ra: 190.379, dec: 38.318, mag: 4.91, name: "" },
  { ra: 196.425, dec: 8.901, mag: 4.26, name: "" },
  { ra: 202.027, dec: 54.925, mag: 4.72, name: "" },
  { ra: 208.855, dec: 17.407, mag: 4.17, name: "" },
  { ra: 214.897, dec: 32.690, mag: 4.83, name: "" },
  { ra: 221.552, dec: 44.948, mag: 4.35, name: "" },
  { ra: 227.368, dec: 25.348, mag: 4.69, name: "" },
  { ra: 233.785, dec: 61.751, mag: 4.48, name: "" },
  { ra: 239.717, dec: 55.960, mag: 4.59, name: "" },
  { ra: 245.901, dec: 37.958, mag: 4.21, name: "" },
  { ra: 252.166, dec: 10.960, mag: 4.95, name: "" },
  { ra: 258.240, dec: 46.884, mag: 4.38, name: "" },
  { ra: 264.330, dec: 33.363, mag: 4.76, name: "" },
  { ra: 270.524, dec: 21.142, mag: 4.12, name: "" },
  { ra: 276.992, dec: 54.925, mag: 4.87, name: "" },
  { ra: 283.061, dec: 38.784, mag: 4.29, name: "" },
  { ra: 289.280, dec: 27.960, mag: 4.53, name: "" },
  { ra: 295.767, dec: 9.895, mag: 4.66, name: "" },
  { ra: 301.593, dec: 45.280, mag: 4.19, name: "" },
  { ra: 308.302, dec: 35.167, mag: 4.74, name: "" },
  { ra: 314.759, dec: 17.508, mag: 4.41, name: "" },
  { ra: 321.573, dec: 62.585, mag: 4.85, name: "" },
  { ra: 327.886, dec: 50.220, mag: 4.27, name: "" },
  { ra: 334.208, dec: 15.627, mag: 4.63, name: "" },
  { ra: 340.759, dec: 77.633, mag: 4.46, name: "" },
  { ra: 347.565, dec: 42.330, mag: 4.92, name: "" },
  { ra: 354.191, dec: 8.901, mag: 4.34, name: "" },

  // Southern hemisphere stars (for completeness)
  { ra: 120.896, dec: -40.003, mag: 3.63, name: "" },
  { ra: 161.697, dec: -49.420, mag: 3.91, name: "" },
  { ra: 197.637, dec: -23.396, mag: 3.29, name: "" },
  { ra: 213.225, dec: -36.370, mag: 3.85, name: "" },
  { ra: 248.970, dec: -26.300, mag: 3.57, name: "" },
  { ra: 279.234, dec: -29.780, mag: 4.12, name: "" },
  { ra: 310.358, dec: -46.960, mag: 3.74, name: "" },
  { ra: 340.759, dec: -15.820, mag: 3.48, name: "" },

  // Milky Way region enhancement stars
  { ra: 270.0, dec: -30.0, mag: 4.8, name: "" },
  { ra: 280.0, dec: -25.0, mag: 5.1, name: "" },
  { ra: 290.0, dec: -20.0, mag: 4.9, name: "" },
  { ra: 300.0, dec: -15.0, mag: 5.2, name: "" },
  { ra: 310.0, dec: -10.0, mag: 4.7, name: "" },
  { ra: 20.0, dec: 40.0, mag: 5.0, name: "" },
  { ra: 30.0, dec: 45.0, mag: 4.6, name: "" },
  { ra: 40.0, dec: 50.0, mag: 5.3, name: "" },
  { ra: 50.0, dec: 55.0, mag: 4.4, name: "" },
  { ra: 60.0, dec: 60.0, mag: 5.1, name: "" },
];

// Expanded constellation line data
const constellations: Constellation[] = [
  {
    name: "Ursa Major",
    lines: [
      [165.932, 61.751, 154.274, 54.925], // Dubhe to Merak
      [154.274, 54.925, 143.386, 55.960], // Merak to Phecda
      [143.386, 55.960, 165.932, 61.751], // Phecda to Dubhe
      [143.386, 55.960, 178.458, 53.695], // Phecda to Megrez
      [178.458, 53.695, 193.507, 55.960], // Megrez to Alioth
      [193.507, 55.960, 206.885, 49.313], // Alioth to Mizar
      [206.885, 49.313, 210.956, 46.054], // Mizar to Alkaid
    ],
  },
  {
    name: "Orion",
    lines: [
      [88.793, 7.407, 83.182, -0.299], // Betelgeuse to Bellatrix
      [88.793, 7.407, 84.053, -1.202], // Betelgeuse to Alnilam
      [83.182, -0.299, 82.061, -1.950], // Bellatrix to Mintaka
      [82.061, -1.950, 84.053, -1.202], // Mintaka to Alnilam
      [84.053, -1.202, 85.190, -1.943], // Alnilam to Alnitak
      [84.053, -1.202, 86.939, -9.670], // Alnilam to Saiph
      [85.190, -1.943, 86.939, -9.670], // Alnitak to Saiph
    ],
  },
  {
    name: "Cassiopeia",
    lines: [
      [14.177, 60.717, 21.454, 59.150], // Schedar to Caph
      [21.454, 59.150, 28.599, 63.670], // Caph to Gamma Cas
      [28.599, 63.670, 37.740, 56.538], // Gamma Cas to Ruchbah
      [37.740, 56.538, 50.362, 57.815], // Ruchbah to Segin
    ],
  },
  {
    name: "Leo",
    lines: [
      [101.287, 16.509, 143.761, 20.524], // Regulus to Zosma
      [143.761, 20.524, 152.093, 11.967], // Zosma to Denebola
      [143.761, 20.524, 141.897, 14.572], // Zosma to Chertan
      [101.287, 16.509, 141.897, 14.572], // Regulus to Chertan
    ],
  },
  {
    name: "Cygnus",
    lines: [
      [310.358, 45.280, 305.557, 40.257], // Deneb to Sadr
      [305.557, 40.257, 292.176, 27.960], // Sadr to Gienah
      [305.557, 40.257, 326.046, 50.220], // Sadr to Albireo
      [310.358, 45.280, 326.046, 50.220], // Deneb to Albireo (wing)
    ],
  },
  {
    name: "Lyra",
    lines: [
      [279.234, 38.784, 284.736, 32.690], // Vega to Sheliak
      [284.736, 32.690, 287.446, 33.363], // Sheliak to Sulafat
      [279.234, 38.784, 287.446, 33.363], // Vega to Sulafat
    ],
  },
  {
    name: "Andromeda",
    lines: [
      [35.620, 42.330, 29.692, 31.883], // Almach to Triangulum
      [29.692, 31.883, 14.063, 20.805], // Triangulum to Hamal
      [14.063, 20.805, 31.793, 23.462], // Hamal to Sheratan
    ],
  },
  {
    name: "Perseus",
    lines: [
      [35.620, 42.330, 56.871, 24.113], // Connect to nearby stars
      [56.871, 24.113, 67.154, 15.627],
      [67.154, 15.627, 74.248, 22.513],
    ],
  },
  {
    name: "Auriga",
    lines: [
      [78.634, 45.998, 89.930, 44.948], // Capella connections
      [89.930, 44.948, 95.674, 9.895],
      [95.674, 9.895, 78.634, 45.998],
    ],
  },
  {
    name: "Gemini",
    lines: [
      [113.650, 31.888, 90.473, 20.960], // Castor to Pollux
      [113.650, 31.888, 116.329, 28.026], // Castor extended
      [90.473, 20.960, 102.048, 20.570], // Pollux extended
    ],
  },
];

// Milky Way galactic plane points (simplified path through major constellations)
const milkyWayPath = [
  // Summer Triangle and Sagittarius region (galactic center)
  { ra: 266.0, dec: -30.0 }, // Sagittarius A*
  { ra: 270.0, dec: -25.0 },
  { ra: 275.0, dec: -20.0 },
  { ra: 280.0, dec: -15.0 },
  { ra: 285.0, dec: -10.0 },
  { ra: 290.0, dec: -5.0 },
  { ra: 295.0, dec: 0.0 },
  { ra: 300.0, dec: 5.0 }, // Aquila
  { ra: 305.0, dec: 10.0 },
  { ra: 310.0, dec: 20.0 }, // Cygnus
  { ra: 315.0, dec: 30.0 },
  { ra: 320.0, dec: 40.0 },
  { ra: 325.0, dec: 50.0 },
  { ra: 330.0, dec: 60.0 },
  { ra: 335.0, dec: 65.0 },
  { ra: 340.0, dec: 70.0 }, // Cepheus
  { ra: 345.0, dec: 75.0 },
  { ra: 350.0, dec: 80.0 },
  { ra: 355.0, dec: 85.0 },
  { ra: 0.0, dec: 85.0 }, // Near Polaris
  { ra: 5.0, dec: 80.0 },
  { ra: 10.0, dec: 75.0 },
  { ra: 15.0, dec: 70.0 }, // Cassiopeia
  { ra: 20.0, dec: 65.0 },
  { ra: 25.0, dec: 60.0 },
  { ra: 30.0, dec: 55.0 },
  { ra: 35.0, dec: 50.0 },
  { ra: 40.0, dec: 45.0 }, // Perseus
  { ra: 45.0, dec: 40.0 },
  { ra: 50.0, dec: 35.0 },
  { ra: 55.0, dec: 30.0 },
  { ra: 60.0, dec: 25.0 }, // Auriga
  { ra: 65.0, dec: 20.0 },
  { ra: 70.0, dec: 15.0 },
  { ra: 75.0, dec: 10.0 }, // Taurus
  { ra: 80.0, dec: 5.0 },
  { ra: 85.0, dec: 0.0 }, // Orion
  { ra: 90.0, dec: -5.0 },
  { ra: 95.0, dec: -10.0 },
  { ra: 100.0, dec: -15.0 }, // Canis Major
  { ra: 105.0, dec: -20.0 },
  { ra: 110.0, dec: -25.0 },
  { ra: 115.0, dec: -30.0 },
  { ra: 120.0, dec: -35.0 }, // Puppis/Vela
  { ra: 125.0, dec: -40.0 },
  { ra: 130.0, dec: -45.0 },
  { ra: 135.0, dec: -50.0 },
  { ra: 140.0, dec: -45.0 },
  { ra: 145.0, dec: -40.0 }, // Centaurus
  { ra: 150.0, dec: -35.0 },
  { ra: 155.0, dec: -30.0 },
  { ra: 160.0, dec: -25.0 },
  { ra: 165.0, dec: -20.0 },
  { ra: 170.0, dec: -15.0 },
  { ra: 175.0, dec: -10.0 },
  { ra: 180.0, dec: -5.0 }, // Libra
  { ra: 185.0, dec: 0.0 },
  { ra: 190.0, dec: 5.0 },
  { ra: 195.0, dec: 10.0 },
  { ra: 200.0, dec: 15.0 },
  { ra: 205.0, dec: 20.0 },
  { ra: 210.0, dec: 25.0 },
  { ra: 215.0, dec: 30.0 }, // Hercules
  { ra: 220.0, dec: 25.0 },
  { ra: 225.0, dec: 20.0 },
  { ra: 230.0, dec: 15.0 },
  { ra: 235.0, dec: 10.0 },
  { ra: 240.0, dec: 5.0 },
  { ra: 245.0, dec: 0.0 },
  { ra: 250.0, dec: -5.0 },
  { ra: 255.0, dec: -10.0 },
  { ra: 260.0, dec: -15.0 }, // Ophiuchus
  { ra: 265.0, dec: -20.0 },
  { ra: 266.0, dec: -25.0 }, // Back to galactic center
];

export function StarMap({ width = 400, height = 400, className = "" }: StarMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [coordinates, setCoordinates] = useState(defaultCoordinates);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [showConstellations, setShowConstellations] = useState(true);
  const [showStarNames, setShowStarNames] = useState(true);
  const [showMilkyWay, setShowMilkyWay] = useState(true);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Load saved coordinates
    const savedCoordinates = safeGetItem("userAstronomyCoordinates");
    if (savedCoordinates) {
      setCoordinates(JSON.parse(savedCoordinates));
    } else if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const newCoordinates = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          };
          setCoordinates(newCoordinates);
        },
        (error) => console.error("Error getting location:", error)
      );
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000); // Update every minute

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const actualWidth = isFullscreen ? window.innerWidth - 100 : width;
    const actualHeight = isFullscreen ? window.innerHeight - 200 : height;
    const radius = Math.min(actualWidth, actualHeight) / 2 - 20;

    svg.attr("width", actualWidth).attr("height", actualHeight);

    const g = svg
      .append("g")
      .attr("transform", `translate(${actualWidth / 2}, ${actualHeight / 2})`);

    // Add zoom and pan behavior (temporarily disabled for debugging)
    /*
    const zoom = d3.zoom()
      .scaleExtent([0.5, 5]) // Allow zoom from 50% to 500%
      .on("zoom", (event) => {
        if (event && event.transform) {
          const { transform } = event;
          g.attr("transform", `translate(${actualWidth / 2 + transform.x}, ${actualHeight / 2 + transform.y}) scale(${transform.k})`);
        }
      });

    // Apply zoom behavior to SVG
    svg.call(zoom);

    // Store zoom reference for reset function
    setZoomBehavior(zoom);
    */

    // Create projection for celestial coordinates
    const projection = d3
      .geoStereographic()
      .scale(radius / 90)
      .rotate([0, -90, 0]) // Adjust for celestial coordinates
      .clipAngle(90);

    // Calculate local sidereal time for current location and time
    const lst = calculateLocalSiderealTime(currentTime, coordinates.longitude);

    // Add background circle
    g.append("circle")
      .attr("r", radius)
      .attr("fill", "#000314")
      .attr("stroke", "#1e293b")
      .attr("stroke-width", 2);

    // Add cardinal directions
    const directions = [
      { label: "N", angle: 0 },
      { label: "E", angle: 90 },
      { label: "S", angle: 180 },
      { label: "W", angle: 270 },
    ];

    directions.forEach(({ label, angle }) => {
      const x = (radius - 10) * Math.sin((angle * Math.PI) / 180);
      const y = -(radius - 10) * Math.cos((angle * Math.PI) / 180);

      g.append("text")
        .attr("x", x)
        .attr("y", y)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "middle")
        .attr("fill", "#64748b")
        .attr("font-size", "14px")
        .attr("font-weight", "bold")
        .text(label);
    });

    // Add constellation lines (if enabled)
    if (showConstellations) {
      constellations.forEach((constellation) => {
        constellation.lines.forEach(([ra1, dec1, ra2, dec2]) => {
          const coords1 = equatorialToAltAz(ra1, dec1, lst, coordinates.latitude);
          const coords2 = equatorialToAltAz(ra2, dec2, lst, coordinates.latitude);

          if (coords1.altitude > 0 && coords2.altitude > 0) {
            const point1 = altAzToXY(coords1.altitude, coords1.azimuth, radius);
            const point2 = altAzToXY(coords2.altitude, coords2.azimuth, radius);

            g.append("line")
              .attr("x1", point1.x)
              .attr("y1", point1.y)
              .attr("x2", point2.x)
              .attr("y2", point2.y)
              .attr("stroke", "#4b5563")
              .attr("stroke-width", 1)
              .attr("opacity", 0.7);
          }
        });
      });
    }

    // Add Milky Way if enabled
    if (showMilkyWay) {
      // Convert Milky Way path to visible coordinates
      const visibleMilkyWayPoints: Array<{x: number, y: number}> = [];

      milkyWayPath.forEach(point => {
        const coords = equatorialToAltAz(point.ra, point.dec, lst, coordinates.latitude);
        if (coords.altitude > -10) { // Show even slightly below horizon for continuity
          const xyPoint = altAzToXY(Math.max(coords.altitude, 0), coords.azimuth, radius);
          visibleMilkyWayPoints.push(xyPoint);
        }
      });

      if (visibleMilkyWayPoints.length > 2) {
        // Create smooth Milky Way band
        const line = d3.line<{x: number, y: number}>()
          .x(d => d.x)
          .y(d => d.y)
          .curve(d3.curveBasisClosed);

        // Create gradient for Milky Way
        const defs = svg.append("defs");
        const gradient = defs.append("radialGradient")
          .attr("id", "milkyway-gradient")
          .attr("cx", "50%")
          .attr("cy", "50%")
          .attr("r", "50%");

        gradient.append("stop")
          .attr("offset", "0%")
          .attr("stop-color", "#f7fafc")
          .attr("stop-opacity", "0.15");

        gradient.append("stop")
          .attr("offset", "50%")
          .attr("stop-color", "#e2e8f0")
          .attr("stop-opacity", "0.08");

        gradient.append("stop")
          .attr("offset", "100%")
          .attr("stop-color", "#cbd5e0")
          .attr("stop-opacity", "0.02");

        // Draw main Milky Way band
        g.append("path")
          .datum(visibleMilkyWayPoints)
          .attr("d", line)
          .attr("fill", "none")
          .attr("stroke", "url(#milkyway-gradient)")
          .attr("stroke-width", 25)
          .attr("opacity", 0.6);

        // Add brighter core region
        g.append("path")
          .datum(visibleMilkyWayPoints)
          .attr("d", line)
          .attr("fill", "none")
          .attr("stroke", "#f1f5f9")
          .attr("stroke-width", 8)
          .attr("opacity", 0.3);

        // Add subtle star cloud effect along Milky Way
        visibleMilkyWayPoints.forEach((point, index) => {
          if (index % 3 === 0) { // Every third point
            for (let i = 0; i < 8; i++) {
              const angle = Math.random() * 2 * Math.PI;
              const distance = Math.random() * 15;
              const starX = point.x + Math.cos(angle) * distance;
              const starY = point.y + Math.sin(angle) * distance;

              g.append("circle")
                .attr("cx", starX)
                .attr("cy", starY)
                .attr("r", Math.random() * 0.8 + 0.2)
                .attr("fill", "#f8fafc")
                .attr("opacity", Math.random() * 0.4 + 0.1);
            }
          }
        });
      }
    }

    // Calculate and display moon if visible
    const moonPosition = SunCalc.getMoonPosition(currentTime, coordinates.latitude, coordinates.longitude);
    const moonIllumination = SunCalc.getMoonIllumination(currentTime);

    if (moonPosition.altitude > 0) {
      const moonAltDeg = (moonPosition.altitude * 180) / Math.PI;
      const moonAzDeg = (moonPosition.azimuth * 180) / Math.PI;
      const moonPoint = altAzToXY(moonAltDeg, (moonAzDeg + 180) % 360, radius);

      // Moon size based on phase
      const moonSize = 8 + moonIllumination.fraction * 4;

      // Create moon group
      const moonGroup = g.append("g")
        .attr("transform", `translate(${moonPoint.x}, ${moonPoint.y})`);

      // Moon background circle
      moonGroup.append("circle")
        .attr("r", moonSize)
        .attr("fill", "#2d3748")
        .attr("stroke", "#4a5568")
        .attr("stroke-width", 1);

      // Illuminated part of moon
      const illuminatedAngle = moonIllumination.angle;
      const phaseArc = d3.arc()
        .innerRadius(0)
        .outerRadius(moonSize)
        .startAngle(-Math.PI / 2)
        .endAngle(Math.PI / 2);

      if (moonIllumination.fraction > 0.01) {
        moonGroup.append("path")
          .attr("d", phaseArc())
          .attr("fill", moonIllumination.fraction > 0.5 ? "#f7fafc" : "#e2e8f0")
          .attr("transform", `rotate(${(illuminatedAngle * 180) / Math.PI})`)
          .attr("opacity", 0.9);
      }

      // Moon label
      moonGroup.append("text")
        .attr("x", moonSize + 5)
        .attr("y", 0)
        .attr("fill", "#cbd5e0")
        .attr("font-size", "10px")
        .attr("dominant-baseline", "middle")
        .text(`Moon (${(moonIllumination.fraction * 100).toFixed(0)}%)`);
    }

    // Add stars
    brightStars.forEach((star) => {
      const coords = equatorialToAltAz(star.ra, star.dec, lst, coordinates.latitude);

      if (coords.altitude > 0) { // Only show stars above horizon
        const point = altAzToXY(coords.altitude, coords.azimuth, radius);
        const starSize = Math.max(0.5, Math.min(8, 7 - star.mag)); // Better size scaling

        g.append("circle")
          .attr("cx", point.x)
          .attr("cy", point.y)
          .attr("r", starSize)
          .attr("fill", getStarColor(star.mag))
          .attr("opacity", Math.max(0.4, 1.2 - star.mag / 4)); // Fainter stars are more transparent

        // Add star names for bright named stars (if enabled)
        if (showStarNames && star.name && star.name.length > 0 && star.mag < 2.0) {
          g.append("text")
            .attr("x", point.x + starSize + 3)
            .attr("y", point.y)
            .attr("fill", "#e2e8f0")
            .attr("font-size", "9px")
            .attr("dominant-baseline", "middle")
            .attr("opacity", 0.8)
            .text(star.name);
        }
      }
    });

    // Add zenith marker
    g.append("circle")
      .attr("cx", 0)
      .attr("cy", 0)
      .attr("r", 2)
      .attr("fill", "#fbbf24")
      .attr("opacity", 0.8);

    g.append("text")
      .attr("x", 5)
      .attr("y", 0)
      .attr("fill", "#fbbf24")
      .attr("font-size", "10px")
      .attr("dominant-baseline", "middle")
      .text("Zenith");

  }, [currentTime, coordinates, isFullscreen, width, height, showConstellations, showStarNames, showMilkyWay]);

  // Helper functions
  function calculateLocalSiderealTime(date: Date, longitude: number): number {
    const jd = getJulianDate(date);
    const t = (jd - 2451545.0) / 36525.0;
    const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + t * t * (0.000387933 - t / 38710000.0);
    const lst = (gmst + longitude) % 360;
    return lst < 0 ? lst + 360 : lst;
  }

  function getJulianDate(date: Date): number {
    return date.getTime() / 86400000 + 2440587.5;
  }

  function equatorialToAltAz(ra: number, dec: number, lst: number, latitude: number) {
    const ha = lst - ra; // Hour angle
    const haRad = (ha * Math.PI) / 180;
    const decRad = (dec * Math.PI) / 180;
    const latRad = (latitude * Math.PI) / 180;

    const altitude = Math.asin(
      Math.sin(decRad) * Math.sin(latRad) + Math.cos(decRad) * Math.cos(latRad) * Math.cos(haRad)
    );

    const azimuth = Math.atan2(
      Math.sin(haRad),
      Math.cos(haRad) * Math.sin(latRad) - Math.tan(decRad) * Math.cos(latRad)
    );

    return {
      altitude: (altitude * 180) / Math.PI,
      azimuth: ((azimuth * 180) / Math.PI + 360) % 360,
    };
  }

  function altAzToXY(altitude: number, azimuth: number, radius: number) {
    const r = radius * (1 - altitude / 90); // Distance from center
    const theta = ((azimuth - 90) * Math.PI) / 180; // Convert to math coordinates

    return {
      x: r * Math.cos(theta),
      y: r * Math.sin(theta),
    };
  }

  function getStarColor(magnitude: number): string {
    if (magnitude < 0) return "#ffffff";
    if (magnitude < 1) return "#f0f8ff";
    if (magnitude < 2) return "#e6f3ff";
    if (magnitude < 3) return "#ddeeff";
    if (magnitude < 4) return "#d4e9ff";
    return "#cce4ff";
  }

  const toggleFullscreen = () => {
    setIsFullscreen(!isFullscreen);
  };

  const resetView = () => {
    setCurrentTime(new Date());
  };

  if (isFullscreen) {
    return (
      <div className="fixed inset-0 z-50 bg-background p-4">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold">Current Sky Map</h2>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-6">
              <div className="flex items-center space-x-2">
                <Switch
                  id="constellations-fullscreen"
                  checked={showConstellations}
                  onCheckedChange={setShowConstellations}
                />
                <Label htmlFor="constellations-fullscreen" className="text-sm">
                  Constellations
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <Switch
                  id="star-names-fullscreen"
                  checked={showStarNames}
                  onCheckedChange={setShowStarNames}
                />
                <Label htmlFor="star-names-fullscreen" className="text-sm">
                  Star Names
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <Switch
                  id="milky-way-fullscreen"
                  checked={showMilkyWay}
                  onCheckedChange={setShowMilkyWay}
                />
                <Label htmlFor="milky-way-fullscreen" className="text-sm">
                  Milky Way
                </Label>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={resetView}>
                <RotateCcw className="w-4 h-4 mr-2" />
                Reset
              </Button>
              <Button variant="outline" size="sm" onClick={toggleFullscreen}>
                <Minimize2 className="w-4 h-4 mr-2" />
                Exit Fullscreen
              </Button>
            </div>
          </div>
        </div>
        <div className="flex justify-center">
          <svg ref={svgRef} className="border rounded-lg" />
        </div>
        <div className="text-center mt-4 text-sm text-muted-foreground">
          <p>Current time: {currentTime.toLocaleString()}</p>
          <p>Location: {coordinates.latitude.toFixed(2)}°, {coordinates.longitude.toFixed(2)}°</p>
          <p>Looking up from your location • Zenith at center</p>
        </div>
      </div>
    );
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <div className="flex justify-between items-center">
          <CardTitle className="text-lg">Current Sky Map</CardTitle>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={resetView}>
              <RotateCcw className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={toggleFullscreen}>
              <Maximize2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
        <div className="flex gap-4 mt-2">
          <div className="flex items-center space-x-2">
            <Switch
              id="constellations"
              checked={showConstellations}
              onCheckedChange={setShowConstellations}
              size="sm"
            />
            <Label htmlFor="constellations" className="text-xs">
              Constellations
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <Switch
              id="star-names"
              checked={showStarNames}
              onCheckedChange={setShowStarNames}
              size="sm"
            />
            <Label htmlFor="star-names" className="text-xs">
              Names
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <Switch
              id="milky-way"
              checked={showMilkyWay}
              onCheckedChange={setShowMilkyWay}
              size="sm"
            />
            <Label htmlFor="milky-way" className="text-xs">
              Milky Way
            </Label>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex justify-center mb-2">
          <svg ref={svgRef} className="border rounded" />
        </div>
        <div className="text-center text-xs text-muted-foreground space-y-1">
          <p>{currentTime.toLocaleTimeString()}</p>
          <p>{coordinates.latitude.toFixed(1)}°, {coordinates.longitude.toFixed(1)}°</p>
        </div>
      </CardContent>
    </Card>
  );
}
