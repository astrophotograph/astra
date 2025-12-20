'use client'

import type {Image as ImageModel, User} from '@/lib/models'
import {useState} from "react"
import {useMeasure} from "@uidotdev/usehooks"
import {Annotation} from "@/components/annotation"
import Image from 'next/image'
import {AnnotationCard} from './annotation-card'
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import {Button} from '@/components/ui/button'
import {Label} from '@/components/ui/label'
import {Input} from '@/components/ui/input'
import {addAnnotation} from "@/app/i/[id]/add-annotation"

// Type for saved circles
type SavedCircle = {
  x: number;
  y: number;
  radius: number;
  name: string;
}

export function ImageViewer({user, image}: { user: User, image: ImageModel }) {
  const [show, setShow] = useState<boolean>(false)
  const [ref, {width, height}] = useMeasure()
  // @ts-ignore
  const placeholder = image?.metadata_?.placeholder || undefined
  const hasVisibleAnnotations = image.annotations && image.normalized_annotations.length > 0

  // State for mouse coordinates
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0, percentX: 0, percentY: 0 })
  const [isHovering, setIsHovering] = useState(false)

  // State for circle drawing
  const [isDrawing, setIsDrawing] = useState(false)
  const [circleStart, setCircleStart] = useState({ x: 0, y: 0 })
  const [circleEnd, setCircleEnd] = useState({ x: 0, y: 0 })
  const [drawnCircles, setDrawnCircles] = useState<Array<{
    x: number,
    y: number,
    radius: number
  }>>([])
  const [drawMode, setDrawMode] = useState(false)

  // State for saved circles
  const [savedCircles, setSavedCircles] = useState<SavedCircle[]>([])

  // State for the save dialog
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [circleName, setCircleName] = useState('')
  const [currentCircle, setCurrentCircle] = useState<{x: number, y: number, radius: number} | null>(null)

  // Calculate circle properties
  const calculateCircleProps = (start: {x: number, y: number}, end: {x: number, y: number}) => {
    const radius = Math.sqrt(
      Math.pow(end.x - start.x, 2) +
      Math.pow(end.y - start.y, 2)
    )

    return {
      x: start.x,
      y: start.y,
      radius
    }
  }

  // Handle mouse movement
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const imageElement = document.getElementById('target-image')
    if (!imageElement) return

    // Get bounding rectangle of image
    const rect = imageElement.getBoundingClientRect()

    // Calculate relative position
    const x = Math.round(e.clientX - rect.left)
    const y = Math.round(e.clientY - rect.top)

    // Calculate percentage position
    const percentX = Math.round((x / rect.width) * 100)
    const percentY = Math.round((y / rect.height) * 100)

    setMousePosition({
      x,
      y,
      percentX,
      percentY
    })

    // Update circle end position if drawing
    if (isDrawing) {
      setCircleEnd({ x, y })
    }
  }

  // Handle mouse enter/leave
  const handleMouseEnter = () => setIsHovering(true)
  const handleMouseLeave = () => {
    setIsHovering(false)
    // Cancel drawing if mouse leaves the image
    if (isDrawing) {
      setIsDrawing(false)
    }
  }

  // Handle mouse down (start drawing)
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!drawMode) return

    const imageElement = document.getElementById('target-image')
    if (!imageElement) return

    // Get bounding rectangle of image
    const rect = imageElement.getBoundingClientRect()

    // Calculate relative position
    const x = Math.round(e.clientX - rect.left)
    const y = Math.round(e.clientY - rect.top)

    setCircleStart({ x, y })
    setCircleEnd({ x, y })
    setIsDrawing(true)
  }

  // Handle mouse up (finish drawing)
  const handleMouseUp = () => {
    if (isDrawing && drawMode) {
      const circle = calculateCircleProps(circleStart, circleEnd)

      // Only add circle if radius is greater than 0
      if (circle.radius > 0) {
        setDrawnCircles([...drawnCircles, circle])
        setCurrentCircle(circle) // Store current circle for potential saving
      }

      setIsDrawing(false)
    }
  }

  // Reset all circles
  const resetCircles = () => {
    setDrawnCircles([])
    setSavedCircles([])
  }

  // Open save dialog
  const openSaveDialog = () => {
    if (drawnCircles.length > 0) {
      const latestCircle = drawnCircles[drawnCircles.length - 1]
      setCurrentCircle(latestCircle)
      setCircleName('')
      setShowSaveDialog(true)
    }
  }

  // Save circle with name
  const saveCircle = async () => {
    if (currentCircle && circleName.trim() !== '') {
      const newSavedCircle: SavedCircle = {
        ...currentCircle,
        name: circleName.trim()
      }

      setSavedCircles([...savedCircles, newSavedCircle])
      setShowSaveDialog(false)

      // Remove the circle from drawn circles as it's now saved
      const newDrawnCircles = [...drawnCircles]
      newDrawnCircles.pop() // Remove the last drawn circle
      setDrawnCircles(newDrawnCircles)

      const scale = width! / image.metadata_.width

      await addAnnotation({
        id: image.id!,
        name: circleName.trim(),
        pixelx: currentCircle.x / scale,
        pixely: currentCircle.y / scale,
        radius: currentCircle.radius / scale,
      })

      // toast({
      //   title: "Circle saved!",
      //   description: "Your circle has been saved successfully.",
      // })
    }
  }

  // todo : ensure metadata is complete!  specifically dimensions!
  return (
    <div className="flex flex-col lg:flex-row gap-8 mt-3">
      <div className="lg:w-2/3">
        <div
          ref={ref}
          className={'relative transition-all duration-1000 ' + (drawMode ? 'cursor-crosshair' : '')}
          onMouseMove={handleMouseMove}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
        >
          <Annotation
            annotations={image.annotations}
            native_width={image.metadata_.width}
            native_height={image.metadata_.height}
            parent_height={height}
            parent_width={width}
            visible={show}
          />

          {/* Image */}
          <Image id="target-image"
                 src={image.image_url}
                 alt=""
                 placeholder={placeholder ? 'blur' : 'empty'}
                 blurDataURL={placeholder}
                 width={image.metadata_.width || 1080}
                 height={image.metadata_.height || 1080}
                 className="w-full h-auto rounded-lg"
                 draggable={false}
          />

          {/* Previously drawn circles */}
          {drawnCircles.map((circle, index) => (
            <div
              key={`drawn-${index}`}
              className="absolute border-2 border-blue-500 rounded-full pointer-events-none"
              style={{
                left: `${circle.x - circle.radius}px`,
                top: `${circle.y - circle.radius}px`,
                width: `${circle.radius * 2}px`,
                height: `${circle.radius * 2}px`
              }}
            />
          ))}

          {/* Saved circles with labels */}
          {savedCircles.map((circle, index) => (
            <div key={`saved-${index}`}>
              <div
                className="absolute border-2 border-green-500 rounded-full pointer-events-none"
                style={{
                  left: `${circle.x - circle.radius}px`,
                  top: `${circle.y - circle.radius}px`,
                  width: `${circle.radius * 2}px`,
                  height: `${circle.radius * 2}px`
                }}
              />
              <div
                className="absolute bg-green-600 text-white px-1 py-0.5 text-xs rounded pointer-events-none"
                style={{
                  left: `${circle.x}px`,
                  top: `${circle.y - circle.radius - 20}px`,
                  transform: 'translateX(-50%)'
                }}
              >
                {circle.name}
              </div>
            </div>
          ))}

          {/* Currently drawing circle */}
          {isDrawing && (
            <div
              className="absolute border-2 border-blue-500 rounded-full pointer-events-none"
              style={{
                left: `${circleStart.x - calculateCircleProps(circleStart, circleEnd).radius}px`,
                top: `${circleStart.y - calculateCircleProps(circleStart, circleEnd).radius}px`,
                width: `${calculateCircleProps(circleStart, circleEnd).radius * 2}px`,
                height: `${calculateCircleProps(circleStart, circleEnd).radius * 2}px`
              }}
            />
          )}

          {/* Coordinates overlay */}
          {isHovering && drawMode  && (
            <div className="absolute top-2 left-2 bg-black bg-opacity-75 text-white px-3 py-1 rounded-md text-sm font-mono z-10">
              x: {mousePosition.x}px ({mousePosition.percentX}%) | y: {mousePosition.y}px ({mousePosition.percentY}%)
              {isDrawing && (
                <>
                  <br />
                  radius: {Math.round(calculateCircleProps(circleStart, circleEnd).radius)}px
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="lg:w-1/3 relative">
        <div className="space-y-6 sticky top-10">
          <h2 className="text-3xl font-bold">{image.summary}</h2>
          {hasVisibleAnnotations && (
            <div className="flex items-center space-x-4">
              {/*{#                    <button id="favoriteBtn"#}*/}
              {/*{#                            class="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded flex items-center">#}*/}
              {/*{#                        <i data-feather="heart" class="mr-2"></i> Favorite#}*/}
              {/*{#                    </button>#}*/}
              <label className="flex items-center cursor-pointer">
                <div className="relative">
                  <input type="checkbox" id="overlayToggle"
                         onChange={() => setShow(!show)}
                  />
                  {/*{#                            <div class="block bg-neutral-600 w-14 h-8 rounded-full"></div>#}*/}
                  {/*{#                            <div class="dot absolute left-1 top-1 bg-white w-6 h-6 rounded-full transition"></div>#}*/}
                </div>
                <div className="ml-3 text-neutral-300 font-medium">
                  Show Annotations
                </div>
              </label>
            </div>
          )}

          <table className="w-full text-left">
            <tbody>
            <tr className="border-b border-neutral-700">
              <th className="py-2 pr-4 font-semibold">Photographer</th>
              <td className="py-2"><a className="underline" href={`/u/${user!.id!}`}>{user!.name!}</a></td>
            </tr>
            {/*{#                        <tr class="border-b border-neutral-700">#}*/}
            {/*{#                            <th class="py-2 pr-4 font-semibold">Date Taken</th>#}*/}
            {/*{#                            <td class="py-2">June 15, 2025</td>#}*/}
            {/*{#                        </tr>#}*/}
            <tr className="border-b border-neutral-700">
              <th className="py-2 pr-4 font-semibold content-start">Location</th>
              <td className="py-2">{image.location}</td>
            </tr>
            {image.metadata_.device && (
              <tr className="border-b border-neutral-700">
                <th className="py-2 pr-4 font-semibold">Device</th>
                <td className="py-2">{image.metadata_.device}</td>
              </tr>
            )}
            {image.description && (
              <tr className="border-b border-neutral-700">
                <th className="py-2 pr-4 font-semibold content-start">Description</th>
                <td className="py-2">{image.description}</td>
              </tr>
            )}
            {image.metadata_ && (
              <>
                {image.metadata_.exposure_date && (
                  <tr className="border-b border-neutral-700">
                    <th className="py-2 pr-4 font-semibold content-start">Exposure Date</th>
                    <td className="py-2">{image.metadata_.exposure_date}</td>
                  </tr>
                )}
                {image.metadata_.total_integration_time && (
                  <tr className="border-b border-neutral-700">
                    <th className="py-2 pr-4 font-semibold content-start">Total Integration Time</th>
                    <td className="py-2">{image.total_integration_time_humanize}</td>
                  </tr>
                )}
              </>
            )}
            {/*{#                        filters: list[str] = Field(default=None, nullable=True)#}*/}
            {/*{#                        number_of_subs: int | None = Field(default=None, nullable=True)#}*/}
            {/*{#                        original_target_name: str | None = Field(default=None, nullable=True)#}*/}
            {/*{#                        original_file_name: str | None = Field(default=None, nullable=True)#}*/}
            {hasVisibleAnnotations && (
              <tr className="border-b border-neutral-700">
                <th className="py-2 pr-4 font-semibold content-start">Annotation</th>
                <td className="py-2">
                  <ul>
                    {image.normalized_annotations.map(annotation => (
                      <li
                        key={JSON.stringify(annotation)}
                        className="underline underline-offset-2 decoration-dotted decoration-1 hover:decoration-solid">
                        <AnnotationCard names={annotation.names}/>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            )}
            </tbody>
          </table>
          <div className="mt-4 space-y-3">
            <div className="flex items-center">
              <label className="flex items-center cursor-pointer">
                <div className="relative">
                  <input
                    type="checkbox"
                    checked={drawMode}
                    onChange={() => setDrawMode(!drawMode)}
                  />
                </div>
                <div className="ml-3 text-neutral-300 font-medium">
                  Add Annotations
                </div>
              </label>
            </div>
            <div className="flex space-x-2">
              {drawnCircles.length > 0 && (
                <Button
                  onClick={openSaveDialog}
                >
                  Save
                </Button>
              )}
              {(drawnCircles.length > 0 || savedCircles.length > 0) && (
                <Button
                  onClick={resetCircles}
                  variant={'destructive'}
                >
                  Reset
                </Button>
              )}
            </div>
          </div>

          {savedCircles.length > 0 && (
            <div className="mt-4 border border-neutral-700 rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-2">Saved Annotations</h3>
              <ul className="space-y-2">
                {savedCircles.map((circle, index) => (
                  <li key={index} className="flex justify-between items-center">
                    <span>{circle.name}</span>
                    <span className="text-sm text-neutral-400">
                      ({circle.x}, {circle.y}) - r: {Math.round(circle.radius)}px
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Save Circle Dialog */}
      <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Save Annotation</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="circle-name" className="text-right">Name</Label>
              <Input
                id="circle-name"
                value={circleName}
                onChange={(e) => setCircleName(e.target.value)}
                placeholder="Enter a name"
                className="col-span-3"
                autoFocus
              />
            </div>
            {currentCircle && (
              <div className="text-sm text-neutral-400 mt-2">
                Position: ({currentCircle.x}, {currentCircle.y}) - Radius: {Math.round(currentCircle.radius)}px
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setShowSaveDialog(false)} variant="outline">
              Cancel
            </Button>
            <Button type="button" onClick={saveCircle}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
