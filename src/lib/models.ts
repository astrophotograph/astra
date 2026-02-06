import {z} from "zod"
import crypto from 'crypto'
import {nanoid} from "nanoid"
import {marked} from "marked"
import {TZDate} from "@date-fns/tz"
import {format} from "date-fns"


export const NGC_TO_MESSIER = {
  "NGC 1952": "M 1",
  "NGC 7089": "M 2",
  "NGC 5272": "M 3",
  "NGC 6121": "M 4",
  "NGC 5904": "M 5",
  "NGC 6405": "M 6",
  "NGC 6475": "M 7",
  "NGC 6523": "M 8",
  "NGC 6333": "M 9",
  "NGC 6254": "M 10",
  "NGC 6705": "M 11",
  "NGC 6218": "M 12",
  "NGC 6205": "M 13",
  "NGC 6402": "M 14",
  "NGC 7078": "M 15",
  "NGC 6611": "M 16",
  "NGC 6618": "M 17",
  "NGC 6613": "M 18",
  "NGC 6273": "M 19",
  "NGC 6514": "M 20",
  "NGC 6531": "M 21",
  "NGC 6656": "M 22",
  "NGC 6494": "M 23",
  "IC 4715": "M 24",
  "IC 4725": "M 25",
  "NGC 6694": "M 26",
  "NGC 6853": "M 27",
  "NGC 6626": "M 28",
  "NGC 6913": "M 29",
  "NGC 7099": "M 30",
  "NGC 224": "M 31",
  "NGC 221": "M 32",
  "NGC 598": "M 33",
  "NGC 1039": "M 34",
  "NGC 2168": "M 35",
  "NGC 1960": "M 36",
  "NGC 2099": "M 37",
  "NGC 1912": "M 38",
  "NGC 7092": "M 39",
  "HD 238107": "M 40",  // one of the two
  "NGC 2287": "M 41",
  "NGC 1976": "M 42",
  "NGC 1982": "M 43",
  "NGC 2632": "M 44",
  "NGC 1432": "M 45",  // Have a better number for this
  "NGC 2437": "M 46",
  "NGC 2422": "M 47",
  "NGC 2548": "M 48",
  "NGC 4472": "M 49",
  "NGC 2323": "M 50",
  "NGC 5194": "M 51",
  "NGC 7654": "M 52",
  "NGC 5024": "M 53",
  "NGC 6715": "M 54",
  "NGC 6809": "M 55",
  "NGC 6779": "M 56",
  "NGC 6720": "M 57",
  "NGC 4579": "M 58",
  "NGC 4621": "M 59",
  "NGC 4649": "M 60",
  "NGC 4303": "M 61",
  "NGC 6266": "M 62",
  "NGC 5055": "M 63",
  "NGC 4826": "M 64",
  "NGC 3623": "M 65",
  "NGC 3627": "M 66",
  "NGC 2682": "M 67",
  "NGC 4590": "M 68",
  "NGC 6637": "M 69",
  "NGC 6681": "M 70",
  "NGC 6838": "M 71",
  "NGC 6981": "M 72",
  "NGC 6994": "M 73",
  "NGC 628": "M 74",
  "NGC 6864": "M 75",
  "NGC 650": "M 76",
  "NGC 1068": "M 77",
  "NGC 2068": "M 78",
  "NGC 1904": "M 79",
  "NGC 6093": "M 80",
  "NGC 3031": "M 81",
  "NGC 3034": "M 82",
  "NGC 5236": "M 83",
  "NGC 4374": "M 84",
  "NGC 4382": "M 85",
  "NGC 4406": "M 86",
  "NGC 4486": "M 87",
  "NGC 4501": "M 88",
  "NGC 4552": "M 89",
  "NGC 4569": "M 90",
  "NGC 4548": "M 91",
  "NGC 6341": "M 92",
  "NGC 2447": "M 93",
  "NGC 4736": "M 94",
  "NGC 3351": "M 95",
  "NGC 3368": "M 96",
  "NGC 3587": "M 97",
  "NGC 4192": "M 98",
  "NGC 4254": "M 99",
  "NGC 4321": "M 100",
  "NGC 5457": "M 101",
  "NGC 5866": "M 102",
  "NGC 581": "M 103",
  "NGC 4594": "M 104",
  "NGC 3379": "M 105",
  "NGC 4258": "M 106",
  "NGC 6171": "M 107",
  "NGC 3556": "M 108",
  "NGC 3992": "M 109",
  "NGC 205": "M 110",
}

export const MessierNames = {
  "M1": "Crab Nebula",
// "M2": "–",
// "M3": "–",
// "M4": "–",
// "M5": "–",
  "M6": "Butterfly Cluster",
  "M7": "Ptolemy’s Cluster",
  "M8": "Lagoon Nebula",
// "M9": "–",
// "M10": "–",
  "M11": "Wild Duck Cluster",
// "M12": "–",
  "M13": "Hercules Globular Cluster",
// "M14": "–",
// "M15": "–",
  "M16": "Eagle Nebula",
  "M17": "Omega Nebula",
// "M18": "–",
// "M19": "–",
  "M20": "Trifid Nebula",
// "M21": "–",
// "M22": "–",
// "M23": "–",
  "M24": "Small Sagittarius Star Cloud",
// "M25": "–",
// "M26": "–",
  "M27": "Dumbbell Nebula",
// "M28": "–",
// "M29": "–",
// "M30": "–",
  "M31": "Andromeda Galaxy",
// "M32": "Dwarf elliptical companion of M31",
  "M33": "Triangulum Galaxy",
// "M34": "–",
// "M35": "–",
// "M36": "–",
// "M37": "–",
// "M38": "–",
// "M39": "–",
// "M40": "Double star (no traditional common name)",
// "M41": "–",
  "M42": "Orion Nebula",
  "M43": "De Mairan's Nebula",
  "M44": "Beehive Cluster",
  "M45": "Pleiades",
// "M46": "–",
// "M47": "–",
// "M48": "–",
// "M49": "–",
// "M50": "–",
  "M51": "Whirlpool Galaxy",
// "M52": "–",
// "M53": "–",
  "M54": "– (Globular cluster in the Sagittarius Dwarf Galaxy)",
// "M55": "–",
// "M56": "–",
  "M57": "Ring Nebula",
// "M58": "–",
// "M59": "–",
// "M60": "–",
// "M61": "–",
// "M62": "–",
  "M63": "Sunflower Galaxy",
  "M64": "Black Eye Galaxy",
// "M65": "–",
// "M66": "–",
// "M67": "– (Open cluster in Cancer)",
// "M68": "–",
// "M69": "–",
// "M70": "–",
// "M71": "–",
// "M72": "–",
// "M73": "–",
  "M74": "Phantom Galaxy",
// "M75": "–",
  "M76": "Little Dumbbell Nebula",
// "M77": "– (Often just “M77”)",
// "M78": "– (Reflection nebula)",
// "M79": "–",
// "M80": "–",
  "M81": "Bode’s Galaxy",
  "M82": "Cigar Galaxy",
  "M83": "Southern Pinwheel Galaxy",
// "M84": "–",
// "M85": "–",
// "M86": "–",
  "M87": "Virgo A",
// "M88": "–",
// "M89": "–",
// "M90": "–",
// "M91": "–",
// "M92": "–",
// "M93": "–",
// "M94": "–",
// "M95": "–",
// "M96": "–",
  "M97": "Owl Nebula",
// "M98": "–",
// "M99": "–",
// "M100": "–",
  "M101": "Pinwheel Galaxy",
// "M102": "– (Disputed identity; sometimes called the Spindle Galaxy)",
// "M103": "–",
  "M104": "Sombrero Galaxy",
// "M105": "–",
// "M106": "–",
// "M107": "–",
// "M108": "–",
// "M109": "–",
// "M110": "Dwarf elliptical companion of M31"
}

// Normalize annotation utility
// export const normalizeAnnotation = (annotation: any, NGC_TO_MESSIER: Record<string, string>): any => {
//   const names: string[] = []
//   for (const name of annotation.names) {
//     // For now we skip HD annotations
//     if (NGC_TO_MESSIER[name]) {
//       names.push(NGC_TO_MESSIER[name])
//     }
//     if (name.startsWith("HD ")) {
//       // In the case of M40, we populate the normalized name, then skip the "HD" name...
//       continue
//     }
//     names.push(name)
//   }
//
//   return {
//     ...annotation,
//     names,
//   }
// }

// Normalized annotations utility
// export const getNormalizedAnnotations = (image: Record<string, never>, NGC_TO_MESSIER: Record<string, string>): never[] => {
//   // @ts-expect-error
//   return image.annotations.map((annotation: never) => normalizeAnnotation(annotation, NGC_TO_MESSIER)).filter(annotation => annotation.names.length > 0)
// }


// export const getExtension = (image: Record<string, any>): string => {
//   if (image.content_type === "image/png") {
//     return ".png"
//   } else if (image.content_type === "image/jpeg") {
//     return ".jpg"
//   } else {
//     return ".jpeg"
//   }
// }

function getImageUrlDirect(url: string, id: string, user_id: string, size: string = '1000', metadata?: any): string {
  // If image has a local URL (uploaded file), serve from uploads path
  if (url && url.startsWith('uploads/')) {
    // Check if we should use thumbnails for smaller sizes
    if (metadata && size === '500' && metadata.thumb500) {
      const filename = metadata.thumb500.split('/').pop();
      return `/uploads/${user_id}/${filename}`;
    }
    if (metadata && (size === '1000' || size === 'medium') && metadata.thumb1000) {
      const filename = metadata.thumb1000.split('/').pop();
      return `/uploads/${user_id}/${filename}`;
    }

    const relativePath = url.replace('uploads/', '')
    return `/uploads/${relativePath}`
  }

  // Otherwise use external URL (legacy images)
  return `https://m.astrophotography.tv/i/${user_id}/${size}/${id}.jpg`

}

export const getImageUrl = (image: Image, size: string = '1000'): string => {
  return getImageUrlDirect(image.url!, image.id!, image.user_id!, size, image.metadata_)
}


// Helper function (you would need to implement this with a library like marked)
function convertMarkdownToHtml(markdown: string | null): string {
  if (!markdown) return ''

  // Signature indicates it could be async, but it shouldn't be...
  return marked.parse(markdown) as string
}

export const UserSchema = z.object({
  id: z.string(),
  username: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  summary: z.string().optional(),
  bio: z.string().optional(),
  description: z.string().optional(),
  email: z.string().optional(),
  metadata_: z.record(z.any()).default({}),
}).transform(values => ({
  ...values,
  // Trick to add computed properties
  get name() {
    return `${values.first_name} ${values.last_name}`
  },
  get initials() {
    return `${values.first_name[0]} ${values.last_name[0]}`
  },
  get avatar_url(): string {
    // default = "https://www.example.com/default.jpg"
    const size = 100
    const defaultImage = "identicon"

    if (!values.email) return ''

    // Encode the email to lowercase
    const emailLowercase = values.email.toLowerCase()

    // Generate the SHA256 hash of the email
    const emailHash = crypto.createHash('sha256')
      .update(emailLowercase)
      .digest('hex')

    // Construct the URL with encoded query parameters
    const queryParams = new URLSearchParams({
      d: defaultImage,
      s: size.toString(),
    }).toString()

    return `https://www.gravatar.com/avatar/${emailHash}?${queryParams}`
  },
}))

export type User = z.infer<typeof UserSchema>;


// Helper function to mimic Python's datetime.utcnow()
const utcNow = () => new Date()

// Create the Collection schema using Zod
export const CollectionSchema = z.object({
  id: z.string().default(() => nanoid()),
  user_id: z.string().nullable(),
  template: z.string().nullable().describe("Empty for default template, \"messier\" for Messier template"),
  name: z.string(),
  description: z.string().nullable(),
  favorite: z.boolean().default(false),
  tags: z.string().nullish(),
  visibility: z.string().default('private'),
  metadata_: z.record(z.any()).default({}),
  created_at: z.date().default(utcNow),
  updated_at: z.date().nullable(),
  // Computed after the fact
  favorite_image: z.string().optional(),
}).transform(values => ({
  ...values,
  get description_html() {
    return convertMarkdownToHtml(values.description)
  },
  get session_date() {
    if (!values.metadata_ || !values.metadata_.session_date) return null

    // const date = new Date(values.metadata_.session_date)
    const date = new TZDate(values.metadata_.session_date, 'UTC')

    return format(date, 'eee MMM dd yyyy')
  },
  get session_date_as_date() {
    // return values.metadata_ && values.metadata_.session_date ? new Date(values.metadata_.session_date).toDateString(): null
    if (!values.metadata_ || !values.metadata_.session_date) return null

    return new TZDate(values.metadata_.session_date, 'UTC')
  },
}))

export const CollectionArraySchema = CollectionSchema.array()

// Type derived from the schema
export type Collection = z.infer<typeof CollectionSchema>;

// Add a utility function to get description HTML
export const getDescriptionHtml = (collection: Collection): string => {
  if (!collection.description) return ''
  // Note: You'll need to add a markdown library implementation here
  // This is a placeholder for the functionality
  return convertMarkdownToHtml(collection.description)
}


export const ImageSchema = z.object({
  id: z.string().nullish(), // This should be sha256
  user_id: z.string().nullable(),
  filename: z.string(),
  url: z.string().nullable(),
  summary: z.string().nullable(), // is this really nullable?
  description: z.string().nullable(),
  content_type: z.string().default('image/png'),
  favorite: z.boolean().default(false),
  tags: z.string().nullable(),
  visibility: z.string().default('private'),
  location: z.string().nullable(),
  annotations: z.record(z.any()).array().default([]), // ??
  metadata_: z.record(z.any()).default({}),
  created_at: z.date().default(() => new Date()),
  updated_at: z.date().nullable(),
  // Computed fields
  short_name: z.string().optional(),
  common_name: z.string().optional(),
  name: z.string().optional(),
}).transform(values => ({
  ...values,
  get image_url() {
    return getImageUrlDirect(values.url!, values.id!, values.user_id!, 'full', values.metadata_)
  },
  get normalized_annotations() {
    return []
    // return getNormalizedAnnotations(values, NGC_TO_MESSIER)
  },
  get description_html() {
    return convertMarkdownToHtml(values.description)
  },
  // get total_integration_time_humanize() {
  //   if (!values.metadata_ || !values.metadata_.total_integration_time) return null
  //
  //   const totalIntegrationTime = values.metadata_.total_integration_time
  //   return humanizeTime(totalIntegrationTime)
  // },
}))

export type Image = z.infer<typeof ImageSchema>;

// Extension utility
// Image URL utility
// Description HTML utility
// export const getDescriptionHtml = (image: Image): string => {
//   // Note: You would need to use a markdown library
//   return image.description || '';
// };

export const ImageArraySchema = ImageSchema.array()


export const AstroObjectSchema = z.object({
  id: z.number().nullable(),
  name: z.string(),
  otype: z.string().nullable(),
  display_name: z.string().nullable(),
  seq: z.number().nullable(), // If there's a natural ordering for the object
  aliases: z.string().nullable(),
  notes: z.string().nullable().default(null), // New field for markdown notes
  metadata_: z.record(z.any()).default({}),
})

export type AstroObject = z.infer<typeof AstroObjectSchema>;

export const AstroObjectArraySchema = AstroObjectSchema.array()
