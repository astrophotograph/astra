// Object List Item Component
import {AstronomyObject} from "@/components/todo-list-types"
import {Button} from "@/components/ui/button"
import {CheckCircle, Circle, Clock, Compass, Edit, FileText, Flag, LineChart, Trash2} from "lucide-react"
import {HoverCard, HoverCardContent, HoverCardTrigger} from "@/components/ui/hover-card"
import {marked} from "marked"

interface ObjectListItemProps {
  object: AstronomyObject;
  currentAltitude: number | null;
  currentAzimuth: { degrees: number | null; direction: string | null };
  maxAltitudeCache: Record<string, string>;
  onToggleCompletion: (id: string) => void;
  onSetGoalTime: (object: AstronomyObject) => void;
  onEditNotes: (object: AstronomyObject) => void;
  onShowAltitude: (object: AstronomyObject) => void;
  onRemove: (id: string) => void;
  onToggleFlag: (id: string) => void;
}

export function ObjectListItem({
                                 object: obj,
                                 currentAltitude,
                                 currentAzimuth,
                                 maxAltitudeCache,
                                 onToggleCompletion,
                                 onSetGoalTime,
                                 onEditNotes,
                                 onShowAltitude,
                                 onRemove,
                                 onToggleFlag,
                               }: ObjectListItemProps) {
  return (
    <div
      className={`grid grid-cols-12 p-4 border-t items-center hover:bg-muted/30 ${obj.completed ? 'bg-muted/20' : ''} ${obj.flagged ? 'border-l-4 border-l-yellow-500' : ''}`}
    >
      <div className="col-span-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onToggleCompletion(obj.id)}
          className="hover:bg-transparent"
          title={obj.completed ? "Mark as incomplete" : "Mark as complete"}
        >
          {obj.completed
            ? <CheckCircle className="h-5 w-5 text-green-500"/>
            : <Circle className="h-5 w-5 text-muted-foreground"/>
          }
        </Button>
      </div>
      <div className="col-span-1 font-medium">
        <HoverCard>
          <HoverCardTrigger asChild>
            <div className="flex items-center">
              <span className={obj.completed ? "line-through text-muted-foreground" : ""}>
                {obj.name}
              </span>
              {obj.notes && (
                <FileText className="h-4 w-4 ml-1 text-blue-500"/>
              )}
              {obj.flagged && (
                <Flag className="h-4 w-4 ml-1 text-yellow-500" fill="currentColor"/>
              )}
            </div>
          </HoverCardTrigger>
          {obj.notes && (
            <HoverCardContent className="w-80 p-4">
              <div
                className="prose prose-sm dark:prose-invert"
                dangerouslySetInnerHTML={{__html: marked(obj.notes)}}
              />
            </HoverCardContent>
          )}
        </HoverCard>
      </div>
      <div className="col-span-1">{obj.objectType || "Unknown"}</div>
      <div className="col-span-1">{obj.ra}</div>
      <div className="col-span-1">{obj.dec}</div>
      <div className="col-span-1">{obj.magnitude}</div>
      <div className="col-span-1">{obj.size}</div>
      <div className="col-span-1">
        {currentAltitude !== null ? (
          <span
            className={
              currentAltitude > 20
                ? "text-green-400"
                : currentAltitude > 0
                  ? "text-yellow-400"
                  : "text-red-400"
            }
            title={
              currentAltitude > 20
                ? "Ideal for observation"
                : currentAltitude > 0
                  ? "Visible but low on horizon"
                  : "Below horizon - not visible"
            }
          >
            {currentAltitude.toFixed(1)}°
          </span>
        ) : (
          "N/A"
        )}
      </div>
      <div className="col-span-1">
        {currentAzimuth.direction ? (
          <span
            className="flex items-center"
            title={`Azimuth: ${currentAzimuth.degrees?.toFixed(1)}°`}
          >
            <Compass className="h-4 w-4 mr-1" />
            {currentAzimuth.direction}
          </span>
        ) : (
          "N/A"
        )}
      </div>
      <div className="col-span-1">
        {maxAltitudeCache[obj.id] ? (
          <span>{maxAltitudeCache[obj.id]}</span>
        ) : (
          <span className="text-muted-foreground">Calculating...</span>
        )}
      </div>
      <div className="col-span-1">
        {obj.goalTime ? (
          <span>{obj.goalTime}</span>
        ) : (
          <span className="text-muted-foreground">Not set</span>
        )}
      </div>
      <div className="col-span-1 text-right space-x-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onToggleFlag(obj.id)}
          title={obj.flagged ? "Remove flag" : "Flag for attention"}
          className={obj.flagged ? "text-yellow-500" : ""}
        >
          <Flag className="h-4 w-4" fill={obj.flagged ? "currentColor" : "none"}/>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onSetGoalTime(obj)}
          title="Set goal observation time"
        >
          <Clock className="h-4 w-4"/>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onEditNotes(obj)}
          title="Edit notes"
        >
          <Edit className="h-4 w-4"/>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onShowAltitude(obj)}
          title="View altitude chart"
        >
          <LineChart className="h-4 w-4"/>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onRemove(obj.id)}
          title="Remove object"
        >
          <Trash2 className="h-4 w-4 text-destructive"/>
        </Button>
      </div>
    </div>
  )
}
