"use client"

import {useEffect, useRef, useState} from "react"
import {Button} from "@/components/ui/button"
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card"
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select"
import {Label} from "@/components/ui/label"
import {MapPin, RotateCcw, Layers, Telescope} from "lucide-react"
import {Switch} from "@/components/ui/switch"
import {Input} from "@/components/ui/input"

interface AladinLiteProps {
  isLoaded?: boolean;
  width?: number;
  height?: number;
  className?: string;
  userLocation?: {
    latitude: number;
    longitude: number;
    city?: string;
  } | null;
}

declare global {
  interface Window {
    A: {
      aladin: (element: HTMLElement, options: Record<string, unknown>) => {
        setImageSurvey: (survey: string) => void;
        setProjection: (projection: string) => void;
        setFoV: (fov: number) => void;
        gotoObject: (target: string) => void;
        addCatalog: (catalog: unknown) => void;
        removeLayers: () => void;
        addOverlay: (overlay: unknown) => void;
        removeOverlay: (overlay: unknown) => void;
        getRaDec: () => [number, number];
        showConstellationLines?: (enabled: boolean) => void;
        view: {
          catalogHpxFOV: () => number;
          showConstellations?: (enabled: boolean) => void;
        };
      };
      catalog: (options: Record<string, unknown>) => {
        addSources: (sources: Array<{
          name: string;
          ra: number;
          dec: number;
          data?: Record<string, unknown>;
        }>) => void;
        show: () => void;
        hide: () => void;
      };
      catalogFromVizieR: (vizierTable: string, name: string, options: Record<string, unknown>) => {
        show: () => void;
        hide: () => void;
      };
      catalogHiPS: (url: string, options: Record<string, unknown>) => {
        show: () => void;
        hide: () => void;
      };
      graphicOverlay: (options: Record<string, unknown>) => {
        addFootprints: (footprints: Array<Record<string, unknown>>) => void;
        add: (shape: unknown) => void;
      };
      rect: (ra: number, dec: number, width: number, height: number, options?: Record<string, unknown>) => unknown;
      source: (ra: number, dec: number, data: Record<string, unknown>) => unknown;
    };
  }
}

type Catalog = {
  id: string;
  name: string;
  targets: null | Array<unknown>;
  source: string;
  url: string;
  options: Record<string, unknown>;
  AladinCatalog: unknown;
  color?: string | undefined;
}

const CatalogSources: Record<string, Catalog> = {
  simbad: {
    id: 'simbad',
    targets: null,
    source: 'simbad',
    name: 'SIMBAD  ',
    AladinCatalog: null,
    url: 'https://hipscat.cds.unistra.fr/HiPSCatService/SIMBAD',
    options: {shape: 'circle', sourceSize: 8, color: '#318d80'},
  },
  messier: {
    id: 'messier',
    name: "Messier",
    targets: null,
    url: "http://localhost:3000/catalogs/Messier.json",
    source: "simbad",
    AladinCatalog: null,
    color: '#29a329',
    options: {shape: 'circle', sourceSize: 8, color: '#318d80'},
  },
  ngc: {
    id: 'ngc',
    name: "NGC",
    targets: null,
    url: "http://localhost:3000/catalogs/OpenNGC.json",
    source: "openngc",
    AladinCatalog: null,
    color: '#cccccc',
    options: {shape: 'circle', sourceSize: 8, color: '#318d80'},
  },
  ic: {
    id: 'ic',
    name: "IC",
    targets: null,
    url: "http://localhost:3000/catalogs/OpenIC.json",
    source: "openngc",
    AladinCatalog: null,
    color: '#cccccc',
    options: {shape: 'circle', sourceSize: 8, color: '#318d80'},
  },
  sharpless: {
    id: 'sharpless',
    name: "Sharpless",
    targets: null,
    url: "http://localhost:3000/catalogs/Sharpless.json",
    source: "simbad",
    AladinCatalog: null,
    color: '#00afff',
    options: {shape: 'circle', sourceSize: 8, color: '#318d80'},
  },
  ldn: {
    id: 'ldn',
    name: "LDN",
    targets: null,
    url: "http://localhost:3000/catalogs/LDN.json",
    source: "vizier",
    AladinCatalog: null,
    color: '#CBCC49',
    options: {shape: 'circle', sourceSize: 8, color: '#318d80'},
  },
  lbn: {
    id: 'lbn',
    name: "LBN",
    targets: null,
    url: "http://localhost:3000/catalogs/LBN.json",
    source: "vizier",
    AladinCatalog: null,
    color: '#CBCC49',
    options: {shape: 'circle', sourceSize: 8, color: '#318d80'},
  },
  barnard: {
    id: 'barnard',
    name: "Barnard",
    targets: null,
    url: "http://localhost:3000/catalogs/Barnard.json",
    source: "vizier",
    AladinCatalog: null,
    color: '#E0FFFF',
    options: {shape: 'circle', sourceSize: 8, color: '#318d80'},
  },  // light cyan
}

function buildCatalogOverlay(aladin, catalogName: keyof typeof CatalogSources) {
  if (!aladin || !window.A) return

  console.log('Building catalog overlay:', catalogName)
  const catalogInfo = CatalogSources[catalogName]
  const catalog = window.A.catalogHiPS(catalogInfo.url, {
    id: catalogInfo.id,
    name: catalogInfo.name,
    shape: catalogInfo.options.shape,
    sourceSize: catalogInfo.options.sourceSize,
    color: catalogInfo.options.color,
    onClick: 'showTable',
  })

  catalog.hide()

  aladin.addCatalog(catalog)

  return catalog
}

const hoursToDeg = 15

function catalogToDataObject(target) {
  // target array
  //   0      1     2      3       4      5       6      7       8      9
  // ["CAT", "RA", "DEC", "TYPE", "CON", "BMAG", "DST", "NAME", "INFO", "SIZE"]
  const catname = target[0]    // CAT
  const extname = target[7]    // NAME
  let dispname
  let size
  if (extname != "") {
    dispname = catname + ', ' + extname
  } else {
    dispname = catname
  }
  if (target.length > 9) {
    size = target[9]
  } else {
    size = 0
  }
  return {
    name: dispname,
    wikiname: catname,
    info: {
      radec: target[1].toFixed(5) + ' ' + target[2].toFixed(5),
      type: target[3],
      constellation: target[4],
      mag: target[5],
      size: size,
      distance: target[6],
      notes: target[8],
    },
  }
}

async function buildJsonCatalog(aladin, catalogName: keyof typeof CatalogSources) {
  if (!aladin || !window.A) return

  const catalog = CatalogSources[catalogName]

  if (catalog.AladinCatalog) return catalog.AladinCatalog

  catalog.AladinCatalog = window.A.catalog({
    id: catalog.id,
    name: catalogName,
    labelColumn: 'name',
    displayLabel: true,
    labelColor: catalog.options.color,
    labelFont: '12px sans-serif',
  })
  catalog.AladinCatalog.hide()

  const response = await fetch(catalog.url)
  catalog.targets = (await response.json()).data

  for (let i = 0; i < catalog.targets.length; i++) {
    if (i == 0) {
      console.log("addJsonToAladinCatalog:add", catalog.targets[i], catalogName)
    }
    catalog.AladinCatalog.addSources(
      window.A.source(
        catalog.targets[i][1] * hoursToDeg,
        catalog.targets[i][2],
        catalogToDataObject(catalog.targets[i])))
  }

  aladin.addCatalog(catalog.AladinCatalog)
  return catalog.AladinCatalog
}


export function AladinLite({width = 800, height = 600, className = "", userLocation, isLoaded}: AladinLiteProps) {
  const divRef = useRef<HTMLDivElement>(null)
  const aladinRef = useRef<{
    setImageSurvey: (survey: string) => void;
    setProjection: (projection: string) => void;
    setFoV: (fov: number) => void;
    gotoObject: (target: string) => void;
    addCatalog: (catalog: unknown) => void;
    removeLayers: () => void;
    addOverlay: (overlay: unknown) => void;
    removeOverlay: (overlay: unknown) => void;
    getRaDec: () => [number, number];
    view: {
      catalogHpxFOV: () => number;
    };
  } | null>(null)
  const [survey, setSurvey] = useState("P/DSS2/color")
  const [projection, setProjection] = useState("SIN")
  const [fov, setFov] = useState(60)
  const [showSimbad, setShowSimbad] = useState(false)
  const [showConstellations, setShowConstellations] = useState(true)
  const [showTelescopeFov, setShowTelescopeFov] = useState(false)
  const [showMessier, setShowMessier] = useState(false)
  const [showNGC, setShowNGC] = useState(false)
  const [showIC, setShowIC] = useState(false)
  const [showSharpless, setShowSharpless] = useState(false)
  const [showLDN, setShowLDN] = useState(false)
  const [showLBN, setShowLBN] = useState(false)
  const [showBarnard, setShowBarnard] = useState(false)
  const [telescopeFovWidth, setTelescopeFovWidth] = useState(30) // arcminutes
  const [telescopeFovHeight, setTelescopeFovHeight] = useState(20) // arcminutes
  const [telescopeFovCenterRa, setTelescopeFovCenterRa] = useState<number | null>(null)
  const [telescopeFovCenterDec, setTelescopeFovCenterDec] = useState<number | null>(null)
  const [activePreset, setActivePreset] = useState<string | null>(null)
  const showTelescopeFovRef = useRef(false)
  const telescopeFovWidthRef = useRef(30)
  const telescopeFovHeightRef = useRef(20)
  const simbadCatalogRef = useRef<unknown>(null)
  const constellationsRef = useRef<unknown>(null)
  const telescopeFovOverlayRef = useRef<unknown>(null)
  const messierCatalogRef = useRef<unknown>(null)
  const ngcCatalogRef = useRef<unknown>(null)
  const icCatalogRef = useRef<unknown>(null)
  const sharplessCatalogRef = useRef<unknown>(null)
  const ldnCatalogRef = useRef<unknown>(null)
  const lbnCatalogRef = useRef<unknown>(null)
  const barnardCatalogRef = useRef<unknown>(null)

  // Initialize Aladin Lite
  useEffect(() => {
    if (!isLoaded || !divRef.current || aladinRef.current) return

    try {
      aladinRef.current = window.A.aladin(divRef.current, {
        survey,
        projection,
        fov,
        target: 'M31', // Default target
        cooFrame: 'ICRS',
        showReticle: true,
        showZoomControl: true,
        showFullscreenControl: true,
        showLayersControl: true,
        showGotoControl: true,
        showShareControl: false,
        showCatalog: true,
        showFrame: true,
        showCooGrid: false,
        reticleColor: '#ff0000',
        reticleSize: 22,
        log: false,
      })

      // Initialize constellation lines if needed
      if (showConstellations) {
        setTimeout(() => toggleConstellations(true), 1000)
      }

      // Add click handler for repositioning FOV rectangle
      aladinRef.current.on('click', (object: any) => {
        // Only move FOV on click, not drag
        if (showTelescopeFovRef.current && !object?.isDragging) {
          if (object?.ra != null && object?.dec != null) {
            updateFovPosition(object.ra, object.dec)
          } else {
            // Try getting coordinates from the current view center if object doesn't have coordinates
            const coords = aladinRef.current.getRaDec()
            updateFovPosition(coords[0], coords[1])
          }
        }
      })

      // // Add constellation lines
      // const constellationsCat = window.A.catalog({
      //   name: 'Constellations',
      //   sourceSize: 5,
      //   color: '#00ff00',
      //   lineWidth: 2,
      // })
      // aladin.addCatalog(constellationsCat)
      // constellationsRef.current = constellationsCat

    } catch (error) {
      console.error('Error initializing Aladin Lite:', error)
    }
  }, [survey, projection, setProjection, fov, isLoaded])

  useEffect(() => {
    if (!aladinRef.current || !window.A) return

    const initializeCatalogs = async () => {
      messierCatalogRef.current = await buildJsonCatalog(aladinRef.current, 'messier')
      ngcCatalogRef.current = await buildJsonCatalog(aladinRef.current, 'ngc')
      icCatalogRef.current = await buildJsonCatalog(aladinRef.current, 'ic')
      sharplessCatalogRef.current = await buildJsonCatalog(aladinRef.current, 'sharpless')
      ldnCatalogRef.current = await buildJsonCatalog(aladinRef.current, 'ldn')
      lbnCatalogRef.current = await buildJsonCatalog(aladinRef.current, 'lbn')
      barnardCatalogRef.current = await buildJsonCatalog(aladinRef.current, 'barnard')
    }

    initializeCatalogs()
  }, [window.A, aladinRef.current])

  // Handle survey change
  const changeSurvey = (newSurvey: string) => {
    setSurvey(newSurvey)
    if (aladinRef.current) {
      aladinRef.current.setImageSurvey(newSurvey)
    }
  }

  // Handle projection change
  const changeProjection = (newProjection: string) => {
    setProjection(newProjection)
    if (aladinRef.current) {
      aladinRef.current.setProjection(newProjection)
    }
  }

  // Handle field of view change
  const changeFov = (newFov: number) => {
    setFov(newFov)
    if (aladinRef.current) {
      aladinRef.current.setFoV(newFov)
    }
  }

  // Go to specific coordinates
  const gotoObject = (target: string) => {
    if (aladinRef.current) {
      aladinRef.current.gotoObject(target)
    }
  }

  // Reset view
  const resetView = () => {
    if (aladinRef.current) {
      aladinRef.current.gotoObject('M31')
      changeFov(60)
    }
  }

  // Go to zenith (overhead position based on user location)
  const gotoZenith = () => {
    if (aladinRef.current && userLocation) {
      // For zenith, we would need current LST calculation
      // For now, just center on a prominent object
      aladinRef.current.gotoObject('Polaris')
    }
  }

  // Toggle Simbad catalog
  const toggleSimbad = async (enabled: boolean) => {
    setShowSimbad(enabled)

    if (!aladinRef.current || !window.A) return

    if (enabled) {
      // Add Simbad catalog
      if (!simbadCatalogRef.current) {
        try {
          simbadCatalogRef.current = buildCatalogOverlay(aladinRef.current, 'simbad')
        } catch (error) {
          console.error('Error adding Simbad catalog:', error)
        }
      }
      simbadCatalogRef.current.show()
    } else {
      simbadCatalogRef.current.hide()
    }
  }

  // Toggle constellation lines
  const toggleConstellations = (enabled: boolean) => {
    setShowConstellations(enabled)

    if (!aladinRef.current || !window.A) return

    try {
      if (enabled) {
        // Create constellation catalog if it doesn't exist
        if (!constellationsRef.current) {
          // Try a simple approach with Hipparcos constellation data
          constellationsRef.current = window.A.catalog({
            name: 'Constellations',
            color: '#00ff00',
            sourceSize: 1,
            shape: 'plus',
            onClick: 'showTable'
          })

          // Add some basic constellation star data manually for testing
          // This is a simplified version - in production you'd load real constellation line data
          const constellationStars = [
            {ra: 23.0625, dec: 89.2641, name: 'Polaris'}, // North Star
            {ra: 14.8461, dec: 74.1556, name: 'Dubhe'}, // Big Dipper
            {ra: 13.3985, dec: 54.9254, name: 'Merak'},
            {ra: 12.2571, dec: 57.0326, name: 'Phecda'},
            {ra: 12.5347, dec: 56.3824, name: 'Megrez'},
          ]

          for (const star of constellationStars) {
            constellationsRef.current.addSources([
              window.A.source(star.ra * 15, star.dec, {name: star.name}) // Convert hours to degrees
            ])
          }

          aladinRef.current.addCatalog(constellationsRef.current)
          console.log('Basic constellation stars added')
        }

        if (constellationsRef.current && constellationsRef.current.show) {
          constellationsRef.current.show()
          console.log('Constellation stars shown')
        }
      } else {
        if (constellationsRef.current && constellationsRef.current.hide) {
          constellationsRef.current.hide()
          console.log('Constellation stars hidden')
        }
      }
    } catch (error) {
      console.error('Error toggling constellation stars:', error)
    }
  }

  // Toggle Messier catalog
  const toggleMessier = (enabled: boolean) => {
    setShowMessier(enabled)
    if (messierCatalogRef.current) {
      if (enabled) {
        messierCatalogRef.current.show()
      } else {
        messierCatalogRef.current.hide()
      }
    }
  }

  // Toggle NGC catalog
  const toggleNGC = (enabled: boolean) => {
    setShowNGC(enabled)
    if (ngcCatalogRef.current) {
      if (enabled) {
        ngcCatalogRef.current.show()
      } else {
        ngcCatalogRef.current.hide()
      }
    }
  }

  // Toggle IC catalog
  const toggleIC = (enabled: boolean) => {
    setShowIC(enabled)
    if (icCatalogRef.current) {
      if (enabled) {
        icCatalogRef.current.show()
      } else {
        icCatalogRef.current.hide()
      }
    }
  }

  // Toggle Sharpless catalog
  const toggleSharpless = (enabled: boolean) => {
    setShowSharpless(enabled)
    if (sharplessCatalogRef.current) {
      if (enabled) {
        sharplessCatalogRef.current.show()
      } else {
        sharplessCatalogRef.current.hide()
      }
    }
  }

  // Toggle LDN catalog
  const toggleLDN = (enabled: boolean) => {
    setShowLDN(enabled)
    if (ldnCatalogRef.current) {
      if (enabled) {
        ldnCatalogRef.current.show()
      } else {
        ldnCatalogRef.current.hide()
      }
    }
  }

  // Toggle LBN catalog
  const toggleLBN = (enabled: boolean) => {
    setShowLBN(enabled)
    if (lbnCatalogRef.current) {
      if (enabled) {
        lbnCatalogRef.current.show()
      } else {
        lbnCatalogRef.current.hide()
      }
    }
  }

  // Toggle Barnard catalog
  const toggleBarnard = (enabled: boolean) => {
    setShowBarnard(enabled)
    if (barnardCatalogRef.current) {
      if (enabled) {
        barnardCatalogRef.current.show()
      } else {
        barnardCatalogRef.current.hide()
      }
    }
  }

  // Update FOV rectangle position
  const updateFovPosition = (ra?: number, dec?: number, force = false, width?: number, height?: number) => {
    if (!aladinRef.current || !window.A || (!showTelescopeFovRef.current && !force)) {
      return
    }

    // Use provided coordinates or current map center
    const targetRa = ra ?? aladinRef.current.getRaDec()[0]
    const targetDec = dec ?? aladinRef.current.getRaDec()[1]

    // Update stored center coordinates
    setTelescopeFovCenterRa(targetRa)
    setTelescopeFovCenterDec(targetDec)

    // Remove existing overlay and create new one at the new position
    if (telescopeFovOverlayRef.current) {
      try {
        aladinRef.current.removeOverlay(telescopeFovOverlayRef.current)
        telescopeFovOverlayRef.current = null
      } catch (error) {
        console.error('Error removing FOV overlay:', error)
      }
    }

    // Create new overlay at the target position
    try {
      const widthDeg = (width ?? telescopeFovWidthRef.current) / 60
      const heightDeg = (height ?? telescopeFovHeightRef.current) / 60

      const overlay = window.A.graphicOverlay({
        color: '#ff0000',
        lineWidth: 2,
        name: 'Telescope FOV',
      })

      // Calculate rectangle corners
      const halfWidth = widthDeg / 2
      const halfHeight = heightDeg / 2

      const fovRect = window.A.polygon([
        [targetRa - halfWidth, targetDec + halfHeight], // Top-left
        [targetRa + halfWidth, targetDec + halfHeight], // Top-right
        [targetRa + halfWidth, targetDec - halfHeight], // Bottom-right
        [targetRa - halfWidth, targetDec - halfHeight]  // Bottom-left
      ], {
        color: '#ff0000',
        lineWidth: 2,
        fillColor: '#ff0000',
        fillOpacity: 0.1,
      })

      overlay.addFootprints(fovRect)
      aladinRef.current.addOverlay(overlay)
      telescopeFovOverlayRef.current = overlay
    } catch (error) {
      console.error('Error creating FOV overlay:', error)
    }
  }

  // Toggle telescope field of view
  const toggleTelescopeFov = (enabled: boolean) => {
    setShowTelescopeFov(enabled)
    showTelescopeFovRef.current = enabled

    if (!aladinRef.current || !window.A) return

    if (enabled) {
      // Add small delay to ensure state is updated, and force the update
      setTimeout(() => updateFovPosition(undefined, undefined, true), 50)
    } else {
      // Remove telescope FOV overlay
      if (telescopeFovOverlayRef.current && aladinRef.current) {
        try {
          aladinRef.current.removeOverlay(telescopeFovOverlayRef.current)
          telescopeFovOverlayRef.current = null
          setTelescopeFovCenterRa(null)
          setTelescopeFovCenterDec(null)
        } catch (error) {
          console.error('Error removing telescope FOV overlay:', error)
        }
      }
    }
  }

  // Update telescope FOV size
  const updateTelescopeFovSize = (width?: number, height?: number) => {
    if (showTelescopeFov) {
      // Update with current center coordinates if available, otherwise use map center
      updateFovPosition(telescopeFovCenterRa ?? undefined, telescopeFovCenterDec ?? undefined, false, width, height)
    }
  }

  if (!isLoaded) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="w-5 h-5"/>
            Aladin Lite Sky Survey
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="flex items-center justify-center border rounded-lg bg-muted/50 w-full"
            style={{height: height}}
          >
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-4"></div>
              <p className="text-muted-foreground">Loading Aladin Lite...</p>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="w-5 h-5"/>
          Aladin Lite Sky Survey
        </CardTitle>
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MapPin className="w-4 h-4"/>
            <span>
              Interactive astronomical sky survey
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={resetView}
              title="Reset view to M31"
            >
              <RotateCcw className="w-4 h-4"/>
            </Button>
            {userLocation && (
              <Button
                variant="outline"
                size="sm"
                onClick={gotoZenith}
                title="Go to zenith (overhead)"
              >
                <MapPin className="w-4 h-4"/>
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Aladin container */}
        <div
          ref={divRef}
          className="border rounded-lg w-full mb-6"
          style={{height: height}}
        />
        
        {/* Controls */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div>
            <Label htmlFor="survey-select">Sky Survey</Label>
            <Select value={survey} onValueChange={changeSurvey}>
              <SelectTrigger className="mt-1">
                <SelectValue/>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="P/DSS2/color">DSS2 Color</SelectItem>
                <SelectItem value="P/DSS2/red">DSS2 Red</SelectItem>
                <SelectItem value="P/2MASS/color">2MASS Color</SelectItem>
                <SelectItem value="P/allWISE/color">AllWISE Color</SelectItem>
                <SelectItem value="P/SDSS9/color">SDSS9 Color</SelectItem>
                <SelectItem value="P/Mellinger/color">Mellinger</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="projection-select">Projection</Label>
            <Select value={projection} onValueChange={changeProjection}>
              <SelectTrigger className="mt-1">
                <SelectValue/>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SIN">Orthographic (SIN)</SelectItem>
                <SelectItem value="STG">Stereographic (STG)</SelectItem>
                <SelectItem value="TAN">Gnomonic (TAN)</SelectItem>
                <SelectItem value="ZEA">Zenithal Equal Area (ZEA)</SelectItem>
                <SelectItem value="AIT">Aitoff (AIT)</SelectItem>
                <SelectItem value="MOL">Mollweide (MOL)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="fov-select">Field of View</Label>
            <Select value={fov.toString()} onValueChange={(value) => changeFov(Number(value))}>
              <SelectTrigger className="mt-1">
                <SelectValue/>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="180">180° (All Sky)</SelectItem>
                <SelectItem value="90">90° (Quarter Sky)</SelectItem>
                <SelectItem value="60">60° (Wide)</SelectItem>
                <SelectItem value="30">30° (Medium)</SelectItem>
                <SelectItem value="15">15° (Narrow)</SelectItem>
                <SelectItem value="5">5° (Very Narrow)</SelectItem>
                <SelectItem value="1">1° (Zoom)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Layer Controls */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-3">
            <Layers className="w-4 h-4"/>
            <Label className="text-sm font-medium">Catalog Layers</Label>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <div className={`flex items-center justify-between p-2 rounded-md transition-colors ${showSimbad ? 'bg-orange-50 border border-orange-200' : 'bg-gray-50/50'}`}>
              <div className="flex items-center gap-2">
                <div
                  className={`w-3 h-3 rounded-full transition-all ${showSimbad ? 'ring-2 ring-orange-300' : ''}`}
                  style={{backgroundColor: '#ff9900'}}
                />
                <Label htmlFor="simbad-toggle" className={`text-sm ${showSimbad ? 'font-medium text-orange-900' : ''}`}>
                  Simbad Objects
                </Label>
              </div>
              <Switch
                id="simbad-toggle"
                checked={showSimbad}
                onCheckedChange={toggleSimbad}
              />
            </div>

            <div className={`flex items-center justify-between p-2 rounded-md transition-colors ${showConstellations ? 'bg-green-50 border border-green-200' : 'bg-gray-50/50'}`}>
              <div className="flex items-center gap-2">
                <div
                  className={`w-3 h-3 rounded-full transition-all ${showConstellations ? 'ring-2 ring-green-300' : ''}`}
                  style={{backgroundColor: '#00ff00'}}
                />
                <Label htmlFor="constellations-toggle" className={`text-sm ${showConstellations ? 'font-medium text-green-900' : ''}`}>
                  Constellation Stars
                </Label>
              </div>
              <Switch
                id="constellations-toggle"
                checked={showConstellations}
                onCheckedChange={toggleConstellations}
              />
            </div>

            <div className={`flex items-center justify-between p-2 rounded-md transition-colors ${showMessier ? 'bg-green-50 border border-green-200' : 'bg-gray-50/50'}`}>
              <div className="flex items-center gap-2">
                <div
                  className={`w-3 h-3 rounded-full transition-all ${showMessier ? 'ring-2 ring-green-300' : ''}`}
                  style={{backgroundColor: '#29a329'}}
                />
                <Label htmlFor="messier-toggle" className={`text-sm ${showMessier ? 'font-medium text-green-900' : ''}`}>
                  Messier
                </Label>
              </div>
              <Switch
                id="messier-toggle"
                checked={showMessier}
                onCheckedChange={toggleMessier}
              />
            </div>

            <div className={`flex items-center justify-between p-2 rounded-md transition-colors ${showNGC ? 'bg-gray-50 border border-gray-300' : 'bg-gray-50/50'}`}>
              <div className="flex items-center gap-2">
                <div
                  className={`w-3 h-3 rounded-full transition-all ${showNGC ? 'ring-2 ring-gray-400' : ''}`}
                  style={{backgroundColor: '#cccccc'}}
                />
                <Label htmlFor="ngc-toggle" className={`text-sm ${showNGC ? 'font-medium text-gray-900' : ''}`}>
                  NGC
                </Label>
              </div>
              <Switch
                id="ngc-toggle"
                checked={showNGC}
                onCheckedChange={toggleNGC}
              />
            </div>

            <div className={`flex items-center justify-between p-2 rounded-md transition-colors ${showIC ? 'bg-gray-50 border border-gray-300' : 'bg-gray-50/50'}`}>
              <div className="flex items-center gap-2">
                <div
                  className={`w-3 h-3 rounded-full transition-all ${showIC ? 'ring-2 ring-gray-400' : ''}`}
                  style={{backgroundColor: '#cccccc'}}
                />
                <Label htmlFor="ic-toggle" className={`text-sm ${showIC ? 'font-medium text-gray-900' : ''}`}>
                  IC
                </Label>
              </div>
              <Switch
                id="ic-toggle"
                checked={showIC}
                onCheckedChange={toggleIC}
              />
            </div>

            <div className={`flex items-center justify-between p-2 rounded-md transition-colors ${showSharpless ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50/50'}`}>
              <div className="flex items-center gap-2">
                <div
                  className={`w-3 h-3 rounded-full transition-all ${showSharpless ? 'ring-2 ring-blue-300' : ''}`}
                  style={{backgroundColor: '#00afff'}}
                />
                <Label htmlFor="sharpless-toggle" className={`text-sm ${showSharpless ? 'font-medium text-blue-900' : ''}`}>
                  Sharpless
                </Label>
              </div>
              <Switch
                id="sharpless-toggle"
                checked={showSharpless}
                onCheckedChange={toggleSharpless}
              />
            </div>

            <div className={`flex items-center justify-between p-2 rounded-md transition-colors ${showLDN ? 'bg-yellow-50 border border-yellow-300' : 'bg-gray-50/50'}`}>
              <div className="flex items-center gap-2">
                <div
                  className={`w-3 h-3 rounded-full transition-all ${showLDN ? 'ring-2 ring-yellow-400' : ''}`}
                  style={{backgroundColor: '#CBCC49'}}
                />
                <Label htmlFor="ldn-toggle" className={`text-sm ${showLDN ? 'font-medium text-yellow-900' : ''}`}>
                  LDN
                </Label>
              </div>
              <Switch
                id="ldn-toggle"
                checked={showLDN}
                onCheckedChange={toggleLDN}
              />
            </div>

            <div className={`flex items-center justify-between p-2 rounded-md transition-colors ${showLBN ? 'bg-yellow-50 border border-yellow-300' : 'bg-gray-50/50'}`}>
              <div className="flex items-center gap-2">
                <div
                  className={`w-3 h-3 rounded-full transition-all ${showLBN ? 'ring-2 ring-yellow-400' : ''}`}
                  style={{backgroundColor: '#CBCC49'}}
                />
                <Label htmlFor="lbn-toggle" className={`text-sm ${showLBN ? 'font-medium text-yellow-900' : ''}`}>
                  LBN
                </Label>
              </div>
              <Switch
                id="lbn-toggle"
                checked={showLBN}
                onCheckedChange={toggleLBN}
              />
            </div>

            <div className={`flex items-center justify-between p-2 rounded-md transition-colors ${showBarnard ? 'bg-cyan-50 border border-cyan-200' : 'bg-gray-50/50'}`}>
              <div className="flex items-center gap-2">
                <div
                  className={`w-3 h-3 rounded-full transition-all ${showBarnard ? 'ring-2 ring-cyan-300' : ''}`}
                  style={{backgroundColor: '#E0FFFF'}}
                />
                <Label htmlFor="barnard-toggle" className={`text-sm ${showBarnard ? 'font-medium text-cyan-900' : ''}`}>
                  Barnard
                </Label>
              </div>
              <Switch
                id="barnard-toggle"
                checked={showBarnard}
                onCheckedChange={toggleBarnard}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Toggle astronomical catalogs and overlays on the sky map
          </p>
        </div>

        {/* Telescope FOV Controls */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-3">
            <Telescope className="w-4 h-4"/>
            <Label className="text-sm font-medium">Telescope Field of View</Label>
          </div>
          <div className="space-y-4">
            <div className={`flex items-center justify-between p-2 rounded-md transition-colors ${showTelescopeFov ? 'bg-red-50 border border-red-200' : 'bg-gray-50/50'}`}>
              <div className="flex items-center gap-2">
                <div
                  className={`w-3 h-3 border-2 transition-colors ${showTelescopeFov ? 'border-red-500 bg-red-500/20' : 'border-red-300 bg-red-500/10'}`}
                />
                <Label htmlFor="telescope-fov-toggle" className={`text-sm ${showTelescopeFov ? 'font-medium text-red-900' : ''}`}>
                  Show FOV Rectangle
                </Label>
              </div>
              <Switch
                id="telescope-fov-toggle"
                checked={showTelescopeFov}
                onCheckedChange={toggleTelescopeFov}
              />
            </div>

            {showTelescopeFov && (
              <div className="pl-6 space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="fov-width" className="text-xs">
                      Width (arcmin)
                    </Label>
                    <Input
                      id="fov-width"
                      type="number"
                      min="1"
                      max="180"
                      value={telescopeFovWidth}
                      onChange={(e) => {
                        const newWidth = Number(e.target.value)
                        setTelescopeFovWidth(newWidth)
                        telescopeFovWidthRef.current = newWidth
                        setActivePreset(null) // Clear active preset when manually changing
                        updateTelescopeFovSize()
                      }}
                      className="mt-1 h-8 text-xs"
                    />
                  </div>
                  <div>
                    <Label htmlFor="fov-height" className="text-xs">
                      Height (arcmin)
                    </Label>
                    <Input
                      id="fov-height"
                      type="number"
                      min="1"
                      max="180"
                      value={telescopeFovHeight}
                      onChange={(e) => {
                        const newHeight = Number(e.target.value)
                        setTelescopeFovHeight(newHeight)
                        telescopeFovHeightRef.current = newHeight
                        setActivePreset(null) // Clear active preset when manually changing
                        updateTelescopeFovSize()
                      }}
                      className="mt-1 h-8 text-xs"
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground">Presets:</Label>
                  <div className="flex flex-wrap gap-1 mt-1">
                    <Button
                      variant={activePreset === 'dslr' ? 'default' : 'outline'}
                      size="sm"
                      className={`h-6 px-2 text-xs ${activePreset === 'dslr' ? 'bg-blue-600 text-white' : ''}`}
                      onClick={() => {
                        setTelescopeFovWidth(34)
                        setTelescopeFovHeight(23)
                        telescopeFovWidthRef.current = 34
                        telescopeFovHeightRef.current = 23
                        setActivePreset('dslr')
                        updateTelescopeFovSize(34, 23)
                      }}
                    >
                      DSLR (34×23)
                    </Button>
                    <Button
                      variant={activePreset === 'ccd' ? 'default' : 'outline'}
                      size="sm"
                      className={`h-6 px-2 text-xs ${activePreset === 'ccd' ? 'bg-blue-600 text-white' : ''}`}
                      onClick={() => {
                        setTelescopeFovWidth(17)
                        setTelescopeFovHeight(13)
                        telescopeFovWidthRef.current = 17
                        telescopeFovHeightRef.current = 13
                        setActivePreset('ccd')
                        updateTelescopeFovSize(17, 13)
                      }}
                    >
                      CCD (17×13)
                    </Button>
                    <Button
                      variant={activePreset === 'smallccd' ? 'default' : 'outline'}
                      size="sm"
                      className={`h-6 px-2 text-xs ${activePreset === 'smallccd' ? 'bg-blue-600 text-white' : ''}`}
                      onClick={() => {
                        setTelescopeFovWidth(7)
                        setTelescopeFovHeight(5)
                        telescopeFovWidthRef.current = 7
                        telescopeFovHeightRef.current = 5
                        setActivePreset('smallccd')
                        updateTelescopeFovSize(7, 5)
                      }}
                    >
                      Small CCD (7×5)
                    </Button>
                    <Button
                      variant={activePreset === 'binoculars' ? 'default' : 'outline'}
                      size="sm"
                      className={`h-6 px-2 text-xs ${activePreset === 'binoculars' ? 'bg-blue-600 text-white' : ''}`}
                      onClick={() => {
                        setTelescopeFovWidth(60)
                        setTelescopeFovHeight(40)
                        telescopeFovWidthRef.current = 60
                        telescopeFovHeightRef.current = 40
                        setActivePreset('binoculars')
                        updateTelescopeFovSize(60, 40)
                      }}
                    >
                      Binoculars (60×40)
                    </Button>
                    <Button
                      variant={activePreset === 'seestar' ? 'default' : 'outline'}
                      size="sm"
                      className={`h-6 px-2 text-xs ${activePreset === 'seestar' ? 'bg-blue-600 text-white' : ''}`}
                      onClick={() => {
                        setTelescopeFovWidth(42)
                        setTelescopeFovHeight(78)
                        telescopeFovWidthRef.current = 42
                        telescopeFovHeightRef.current = 78
                        setActivePreset('seestar')
                        updateTelescopeFovSize(42, 78)
                      }}
                    >
                      Seestar S50 (42×78)
                    </Button>
                  </div>
                </div>

                {/* FOV Center Coordinates Display */}
                {telescopeFovCenterRa !== null && telescopeFovCenterDec !== null && (
                  <div className="mt-3 p-2 bg-muted/50 rounded-md">
                    <Label className="text-xs text-muted-foreground">FOV Center:</Label>
                    <div className="grid grid-cols-2 gap-2 mt-1">
                      <div className="text-xs">
                        <span className="text-muted-foreground">RA:</span> {telescopeFovCenterRa.toFixed(4)}°
                      </div>
                      <div className="text-xs">
                        <span className="text-muted-foreground">Dec:</span> {telescopeFovCenterDec.toFixed(4)}°
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Display a red rectangle showing your telescope&apos;s field of view. Click anywhere on the sky map to move the FOV rectangle to that position.
          </p>
        </div>

        {/* Quick navigation */}
        <div className="flex flex-wrap gap-2 mb-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => gotoObject('M31')}
          >
            Andromeda Galaxy
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => gotoObject('M42')}
          >
            Orion Nebula
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => gotoObject('M45')}
          >
            Pleiades
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => gotoObject('M13')}
          >
            Hercules Cluster
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => gotoObject('Polaris')}
          >
            North Star
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => gotoObject('Vega')}
          >
            Vega
          </Button>
        </div>

        {/* Instructions */}
        <div className="mt-4 text-xs text-muted-foreground space-y-1">
          <p>• <strong>Mouse:</strong> Left-click and drag to pan, scroll to zoom</p>
          <p>• <strong>Right-click:</strong> Context menu with object information</p>
          <p>• <strong>Controls:</strong> Use the overlay controls for layers, goto, and fullscreen</p>
          <p>• <strong>Surveys:</strong> Switch between different astronomical image surveys</p>
          <p>• <strong>Layer Toggles:</strong> Show/hide Simbad objects, Hipparcos stars, and constellation lines</p>
          <p>• <strong>Telescope FOV:</strong> Display a red rectangle showing your telescope&apos;s field of view</p>
          <p>• <strong>Simbad:</strong> Database of astronomical objects with detailed information</p>
        </div>
      </CardContent>
    </Card>
  )
}
