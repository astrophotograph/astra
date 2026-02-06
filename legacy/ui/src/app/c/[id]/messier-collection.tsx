// Path: app/c/[id]/messier-collection.tsx
'use client'

import {useEffect, useRef, useState} from 'react'
import type {Collection, Image, User} from "@/lib/models"
// import { CollectionHeader } from "@/app/c/[id]/collection-header"
import {Card, CardContent} from "@/components/ui/card"
import {Input} from "@/components/ui/input"
import {Label} from "@/components/ui/label"
import {ScrollArea} from "@/components/ui/scroll-area"
import {HoverCard, HoverCardContent, HoverCardTrigger} from "@/components/ui/hover-card"
import {Search} from "lucide-react"
import {getImages} from "@/app/c/[id]/get-images"
import {getCatalogObjects} from "@/app/c/[id]/fetch-catalog-objects"
import {AstroObjectAction} from "@/lib/fetch-astro-object-action"

// Messier catalog object types
const messierTypes: Record<string, { name: string, color: string }> = {
  'Galaxy': { name: 'Galaxy', color: '#6366f1' },
  'CL+NB': { name: 'Cluster with Nebulosity', color: '#ec4899' },
  'Open Cluster': { name: 'Open Cluster', color: '#f59e0b' },
  'Globular Cluster': { name: 'Globular Cluster', color: '#10b981' },
  'Planetary Nebula': { name: 'Planetary Nebula', color: '#3b82f6' },
  'DIFFNEB': { name: 'Diffuse Nebula', color: '#8b5cf6' },
  'SuperNova Remnant': { name: 'Supernova Remnant', color: '#ef4444' }
}

// Define a Messier object type
interface MessierObject {
  id: string
  messier: number  // M number (e.g., M1, M42)
  name: string
  type: string //keyof typeof messierTypes
  ra: number  // Right ascension
  dec: number // Declination
  mag: number // Magnitude
  size: number // Angular size in arcminutes
  distance: number // Distance in light years
  imageId?: string // Optional reference to an image in the collection
}

// Mock function to map collection images to Messier objects
// In a real app, you would likely have this data in your database
function mapImagesToMessierObjects(objects: AstroObjectAction[],  images: Image[]): MessierObject[] {
  // This is a simplistic implementation - in a real app, this data would come from your backend
  const messierObjects: MessierObject[] = []

  // Sample data for demonstration
  const sampleData = [
    { messier: 1, name: "Crab Nebula", type: "SNR" as keyof typeof messierTypes, ra: 83.63, dec: 22.01, mag: 8.4, size: 6, distance: 6500 },
    { messier: 8, name: "Lagoon Nebula", type: "DIFFNEB" as keyof typeof messierTypes, ra: 270.92, dec: -24.38, mag: 6.0, size: 90, distance: 5200 },
    { messier: 13, name: "Great Globular Cluster in Hercules", type: "GLOCL" as keyof typeof messierTypes, ra: 250.42, dec: 36.46, mag: 5.8, size: 20, distance: 22200 },
    { messier: 31, name: "Andromeda Galaxy", type: "GALXY" as keyof typeof messierTypes, ra: 10.68, dec: 41.27, mag: 3.4, size: 178, distance: 2500000 },
    { messier: 42, name: "Orion Nebula", type: "DIFFNEB" as keyof typeof messierTypes, ra: 83.82, dec: -5.39, mag: 4.0, size: 85, distance: 1344 },
    { messier: 45, name: "Pleiades", type: "OPNCL" as keyof typeof messierTypes, ra: 56.75, dec: 24.12, mag: 1.6, size: 110, distance: 440 },
    { messier: 51, name: "Whirlpool Galaxy", type: "GALXY" as keyof typeof messierTypes, ra: 202.47, dec: 47.20, mag: 8.4, size: 11, distance: 23000000 },
    { messier: 57, name: "Ring Nebula", type: "PLNNB" as keyof typeof messierTypes, ra: 283.40, dec: 33.03, mag: 8.8, size: 1.5, distance: 2300 },
    { messier: 81, name: "Bode's Galaxy", type: "GALXY" as keyof typeof messierTypes, ra: 148.89, dec: 69.07, mag: 6.9, size: 21, distance: 12000000 },
    { messier: 87, name: "Virgo A", type: "GALXY" as keyof typeof messierTypes, ra: 187.71, dec: 12.39, mag: 8.6, size: 7, distance: 53500000 },
    { messier: 97, name: "Owl Nebula", type: "PLNNB" as keyof typeof messierTypes, ra: 168.70, dec: 55.02, mag: 9.9, size: 3.2, distance: 2600 },
    { messier: 104, name: "Sombrero Galaxy", type: "GALXY" as keyof typeof messierTypes, ra: 189.98, dec: -11.62, mag: 8.0, size: 9, distance: 29300000 }
  ]

  objects.forEach((data, index) => {
    messierObjects.push({
      id: `${data!.id!}`,
      messier: data!.seq!,
      name: data?.common_name ?? `Messier ${data!.seq!}`,
      type: data!.object_type!,
      ra: 0,
      dec: 0,
      mag: 0,
      size: 0,
      distance: 0,
    })
  })
  // Map sample data to MessierObject format
  // sampleData.forEach((data, index) => {
  //   // Try to match with an image if available
  //   const matchingImage = images.find(img =>
  //     img.description?.toLowerCase().includes(`m${data.messier}`) ||
  //     img.description?.toLowerCase().includes(data.name.toLowerCase())
  //   )
  //
  //   messierObjects.push({
  //     id: `messier-${data.messier}`,
  //     ...data,
  //     // @ts-ignore
  //     imageId: matchingImage?.id
  //   })
  // })

  return messierObjects
}

interface MessierCollectionProps {
  id: string
  user: User
  collection: Collection
}

export function MessierCollection({
  id,
  user,
  collection,
}: MessierCollectionProps) {
  // Using client component with server data
  const [images, setImages] = useState<Image[]>([])
  const [messierObjects, setMessierObjects] = useState<MessierObject[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const svgRef = useRef<SVGSVGElement>(null)

  // Filter messier objects based on search term
  const filteredObjects = messierObjects.filter(obj =>
    obj.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    `m${obj.messier}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
    obj.type.toLowerCase().includes(searchTerm.toLowerCase())
  )

  // Fetch images and create messier objects
  useEffect(() => {
    async function loadData() {
      setIsLoading(true)
      try {
        const messierObjects = await getCatalogObjects('Messier')
        const collectionImages = await getImages(id)
        setImages(collectionImages)
        setMessierObjects(mapImagesToMessierObjects(messierObjects, collectionImages))
      } catch (error) {
        console.error('Error loading Messier collection data:', error)
      } finally {
        setIsLoading(false)
      }
    }
    loadData()
  }, [id])

  // Create the visualization when component mounts or data changes
  // useEffect(() => {
  //   if (!svgRef.current || messierObjects.length === 0) return
  //
  //   const width = svgRef.current.clientWidth
  //   const height = 500
  //   const margin = { top: 20, right: 20, bottom: 40, left: 40 }
  //   const innerWidth = width - margin.left - margin.right
  //   const innerHeight = height - margin.top - margin.bottom
  //
  //   // Clear previous visualization
  //   d3.select(svgRef.current).selectAll('*').remove()
  //
  //   const svg = d3.select(svgRef.current)
  //     .attr('width', width)
  //     .attr('height', height)
  //
  //   const g = svg.append('g')
  //     .attr('transform', `translate(${margin.left},${margin.top})`)
  //
  //   // Create scales
  //   const xScale = d3.scaleLinear()
  //     .domain([0, 360]) // Right ascension (0 to 360 degrees)
  //     .range([0, innerWidth])
  //
  //   const yScale = d3.scaleLinear()
  //     .domain([-90, 90]) // Declination (-90 to 90 degrees)
  //     .range([innerHeight, 0])
  //
  //   const sizeScale = d3.scaleLog()
  //     .domain([1, d3.max(messierObjects, d => d.size) || 100])
  //     .range([4, 15])
  //
  //   // Add axes
  //   g.append('g')
  //     .attr('transform', `translate(0,${innerHeight})`)
  //     .call(d3.axisBottom(xScale).ticks(12))
  //     .append('text')
  //     .attr('x', innerWidth / 2)
  //     .attr('y', 35)
  //     .attr('fill', 'currentColor')
  //     .attr('text-anchor', 'middle')
  //     .text('Right Ascension (degrees)')
  //
  //   g.append('g')
  //     .call(d3.axisLeft(yScale))
  //     .append('text')
  //     .attr('transform', 'rotate(-90)')
  //     .attr('y', -35)
  //     .attr('x', -innerHeight / 2)
  //     .attr('fill', 'currentColor')
  //     .attr('text-anchor', 'middle')
  //     .text('Declination (degrees)')
  //
  //   // Create a tooltip
  //   const tooltip = d3.select('body').append('div')
  //     .attr('class', 'absolute hidden p-2 bg-black/80 text-white text-xs rounded pointer-events-none')
  //
  //   // Add circles for each Messier object
  //   g.selectAll('circle')
  //     .data(messierObjects)
  //     .enter()
  //     .append('circle')
  //     .attr('cx', d => xScale(d.ra))
  //     .attr('cy', d => yScale(d.dec))
  //     .attr('r', d => sizeScale(d.size))
  //     .attr('fill', d => messierTypes[d.type].color)
  //     .attr('opacity', 0.7)
  //     .attr('stroke', '#fff')
  //     .attr('stroke-width', d => d.imageId ? 2 : 0)
  //     .on('mouseover', (event, d) => {
  //       tooltip.classed('hidden', false)
  //         .html(`<div>
  //           <div class="font-bold">M${d.messier} - ${d.name}</div>
  //           <div>Type: ${messierTypes[d.type].name}</div>
  //           <div>Magnitude: ${d.mag}</div>
  //           <div>Size: ${d.size} arcmin</div>
  //           <div>Distance: ${d.distance.toLocaleString()} light years</div>
  //         </div>`)
  //         .style('left', `${event.pageX + 10}px`)
  //         .style('top', `${event.pageY + 10}px`)
  //     })
  //     .on('mouseout', () => {
  //       tooltip.classed('hidden', true)
  //     })
  //     .on('click', (_, d) => {
  //       if (d.imageId) {
  //         window.location.href = `/i/${d.imageId}`
  //       }
  //     })
  //     .append('title')
  //     .text(d => `M${d.messier} - ${d.name}`)
  //
  //   // Add text labels for selected objects
  //   g.selectAll('text.label')
  //     .data(messierObjects.filter(d => d.imageId)) // Only label objects with images
  //     .enter()
  //     .append('text')
  //     .attr('class', 'label')
  //     .attr('x', d => xScale(d.ra) + 8)
  //     .attr('y', d => yScale(d.dec) + 4)
  //     .attr('fill', 'currentColor')
  //     .attr('font-size', '10px')
  //     .text(d => `M${d.messier}`)
  //
  //   // Add a legend
  //   const legend = svg.append('g')
  //     .attr('transform', `translate(${width - 150}, 50)`)
  //
  //   const legendEntries = Object.entries(messierTypes)
  //
  //   legendEntries.forEach(([type, info], i) => {
  //     const legendRow = legend.append('g')
  //       .attr('transform', `translate(0, ${i * 20})`)
  //
  //     legendRow.append('circle')
  //       .attr('cx', 0)
  //       .attr('cy', 0)
  //       .attr('r', 6)
  //       .attr('fill', info.color)
  //       .attr('opacity', 0.7)
  //
  //     legendRow.append('text')
  //       .attr('x', 12)
  //       .attr('y', 4)
  //       .attr('fill', 'currentColor')
  //       .attr('font-size', '10px')
  //       .text(info.name)
  //   })
  //
  //   // Cleanup function
  //   return () => {
  //     tooltip.remove()
  //   }
  // }, [messierObjects, searchTerm])

  return (
    <main className="container mx-auto py-8">
      {/*<CollectionHeader name={collection.name} user={user} collection={collection}/>*/}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mt-8">
        {/* Messier Object List Panel */}
        <div className="lg:col-span-1">
          <Card>
            <CardContent className="p-5">
              <div className="mb-4">
                <Label htmlFor="search">Search Messier Objects</Label>
                <div className="relative">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="search"
                    placeholder="Search by name, M number, or type..."
                    className="pl-8"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
              </div>

              <h3 className="text-lg font-medium mb-2">
                Messier Objects {searchTerm && `(${filteredObjects.length} results)`}
              </h3>

              {isLoading ? (
                <div className="flex justify-center items-center h-60">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                </div>
              ) : (
                <ScrollArea className="h-[500px] pr-4">
                  <div className="space-y-2">
                    {filteredObjects.map(object => (
                      <HoverCard key={object.id}>
                        <HoverCardTrigger asChild>
                          <div
                            className={`p-3 rounded-md border ${object.imageId ? 'cursor-pointer hover:bg-secondary/50' : ''}`}
                            onClick={() => object.imageId && window.location.assign(`/i/${object.imageId}`)}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center">
                                <div
                                  className="w-3 h-3 rounded-full mr-2"
                                  style={{ backgroundColor: messierTypes[object.type]?.color ?? '#a0a0a0' }}
                                ></div>
                                <span className="font-medium">M{object.messier}</span>
                              </div>
                              <span className="text-sm text-muted-foreground">{object.type}</span>
                            </div>
                            <div className="mt-1 text-sm">{object.name}</div>
                            {object.imageId && (
                              <div className="mt-1 text-xs text-primary">View image →</div>
                            )}
                          </div>
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80">
                          <div className="space-y-2">
                            <h4 className="text-sm font-semibold">M{object.messier} - {object.name}</h4>
                            <div className="text-xs space-y-1">
                              {/*<div><span className="font-medium">Type:</span> {messierTypes[object.type].name}</div>*/}
                              <div><span className="font-medium">Magnitude:</span> {object.mag}</div>
                              <div><span className="font-medium">Size:</span> {object.size} arcmin</div>
                              <div><span className="font-medium">Distance:</span> {object.distance.toLocaleString()} light years</div>
                              <div><span className="font-medium">Coordinates:</span> RA: {object.ra}°, Dec: {object.dec}°</div>
                            </div>
                          </div>
                        </HoverCardContent>
                      </HoverCard>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Visualization Panel */}
        {/*<div className="lg:col-span-2">*/}
        {/*  <Card>*/}
        {/*    <CardContent className="p-5">*/}
        {/*      <h3 className="text-lg font-medium mb-4">Celestial Map Visualization</h3>*/}
        {/*      <p className="text-sm text-muted-foreground mb-4">*/}
        {/*        This map shows the position of Messier objects in the night sky. Objects with images in this*/}
        {/*        collection are highlighted with a white border. Click on an object to view its image.*/}
        {/*      </p>*/}
        {/*      <div className="mt-4 w-full overflow-hidden bg-black/5 dark:bg-white/5 rounded-lg p-4">*/}
        {/*        <svg ref={svgRef} className="w-full" preserveAspectRatio="xMidYMid meet"></svg>*/}
        {/*      </div>*/}
        {/*      <div className="mt-4 text-sm text-muted-foreground">*/}
        {/*        <p>The Messier catalog was compiled by French astronomer Charles Messier in the late 18th century.*/}
        {/*        It contains 110 deep sky objects including galaxies, nebulae, and star clusters.</p>*/}
        {/*      </div>*/}
        {/*    </CardContent>*/}
        {/*  </Card>*/}

        {/*  {collection.description && (*/}
        {/*    <Card className="mt-6">*/}
        {/*      <CardContent className="p-5">*/}
        {/*        <h3 className="text-lg font-medium mb-2">About This Collection</h3>*/}
        {/*        <div*/}
        {/*          className="prose dark:prose-invert"*/}
        {/*          dangerouslySetInnerHTML={{ __html: collection.description_html || '' }}*/}
        {/*        />*/}
        {/*      </CardContent>*/}
        {/*    </Card>*/}
        {/*  )}*/}
        {/*</div>*/}
      </div>
    </main>
  )
}
