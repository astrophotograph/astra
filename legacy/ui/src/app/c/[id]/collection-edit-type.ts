import {z} from "zod"

export const formSchema = z.object({
  // template: z.string().nullable().describe("Empty for default template, \"messier\" for Messier template"),
  id: z.string(),
  name: z.string().min(2, {
    message: 'Name is required',
  }),
  description: z.string().nullable(),
  favorite: z.boolean().optional(),
  tags: z.string().nullable(),
  // visibility: z.string().default('private'),
  // metadata: z.record(z.any()).default({}),
  // Metadata fields
  video: z.string().optional(),
  session_date: z.string().optional(),
})
