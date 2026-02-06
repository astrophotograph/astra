'use client'

import {Image} from "@/lib/models"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import {Textarea} from "@/components/ui/textarea"
import {z} from "zod"
import {zodResolver} from "@hookform/resolvers/zod"
import {useForm} from "react-hook-form"
import {Form, FormControl, FormDescription, FormField, FormItem, FormLabel} from "@/components/ui/form"
import {useIsSsr} from "@/lib/use-ssr"
import {Switch} from "@/components/ui/switch"
import {useState} from "react"
import {useRouter} from "next/navigation"
import {imageFormSchema} from "@/app/i/[id]/edit-types"
import {saveImage} from "@/app/i/[id]/save-image"


export function EditImageForm({image}: { image: Image }) {
  const isSsr = useIsSsr()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const form = useForm<z.infer<typeof imageFormSchema>>({
    resolver: zodResolver(imageFormSchema),
    defaultValues: {
      id: image.id!, // todo : make sure this can't be modified from client!
      summary: image.summary!,
      description: image.description,
      location: image.location,
      tags: image.tags,
    },
  })
  //   content_type: z.string().default('image/png'),
  //   favorite: z.boolean().default(false),
  //   visibility: z.string().default('private'),
  //   annotations: z.record(z.any()).array().default([]),
  //   metadata_: z.record(z.any()).default({}),
  //   created_at: z.date().default(() => new Date()),
  //   updated_at: z.date().nullable(),

  if (isSsr) return null

  async function onSubmit(values: z.infer<typeof imageFormSchema>) {
    // Do something with the form values.
    // ✅ This will be type-safe and validated.
    await saveImage(values)

    setOpen(false)

    router.refresh()
  }

  // @ts-ignore
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/*<Button variant="outline">Edit Profile</Button>*/}
        <Button variant={'secondary'}>Edit</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
            <DialogHeader>
              <DialogTitle>Edit image</DialogTitle>
              <DialogDescription>
                Make changes to the current image here. Click save when you're done.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <FormField control={form.control}
                         name={'summary'}
                         render={({field}) => (
                           <FormItem>
                             <FormLabel>Summary</FormLabel>
                             <FormControl>
                               <Input {...field}/>
                             </FormControl>
                           </FormItem>
                         )}
              />
              <FormField control={form.control}
                         name={'description'}
                         render={({field}) => (
                           <FormItem>
                             <FormLabel>Description</FormLabel>
                             <FormControl>
                               {/* @ts-ignore */}
                               <Textarea
                                 placeholder={'Add your description here'}
                                 className={'resize-none'}
                                 {...field}/>
                             </FormControl>
                           </FormItem>
                         )}
              />
              <FormField control={form.control}
                         name={'location'}
                         render={({field}) => (
                           <FormItem>
                             <FormLabel>Location</FormLabel>
                             <FormControl>
                               {/* @ts-ignore */}
                               <Input {...field}/>
                             </FormControl>
                           </FormItem>
                         )}
              />
              <FormField control={form.control}
                         name={'tags'}
                         render={({field}) => (
                           <FormItem>
                             <FormLabel>Tags</FormLabel>
                             <FormControl>
                               {/* @ts-ignore */}
                               <Input {...field}/>
                             </FormControl>
                             <FormDescription>
                               Enter a comma-delimited list of tags.
                             </FormDescription>
                           </FormItem>
                         )}
              />
              <FormField
                control={form.control}
                name="favorite"
                render={({field}) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-sm">
                    <div className="space-y-0.5">
                      <FormLabel>Favorite</FormLabel>
                      <FormDescription>
                        Feature this collection in your "Featured Collections" section on your home page.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <Button type="submit">Save changes</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
