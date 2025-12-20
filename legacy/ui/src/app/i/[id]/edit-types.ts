import {z} from "zod"

export const imageFormSchema = z.object({
  // template: z.string().nullable().describe("Empty for default template, \"messier\" for Messier template"),
  id: z.string(),
  summary: z.string().min(2, {
    message: 'Summary is required',
  }),
  description: z.string().nullable(),
  favorite: z.boolean().optional(),
  tags: z.string().nullable(),
  location: z.string().nullable(),
  // visibility: z.string().default('private'),
  // metadata: z.record(z.any()).default({}),
  // Metadata fields
  // video: z.string().optional(),
})

export const annotationFormSchema = z.object({
  id: z.string(),
  name: z.string().min(2, {}),
  pixelx: z.number().min(0, {}),
  pixely: z.number().min(0, {}),
  radius: z.number().min(0, {}),
})
