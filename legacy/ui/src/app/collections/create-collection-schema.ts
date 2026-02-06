import {z} from "zod"

export const createCollectionSchema = z.object({
  name: z.string().min(1, {
    message: 'Collection name is required',
  }).max(100, {
    message: 'Collection name must be less than 100 characters',
  }),
  description: z.string().optional(),
  template: z.string().optional(),
  visibility: z.enum(['private', 'public']).default('private'),
  tags: z.string().optional(),
  session_date: z.string().optional(),
})

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>