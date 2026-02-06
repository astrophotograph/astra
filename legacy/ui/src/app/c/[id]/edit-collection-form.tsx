'use client'

import {Collection} from "@/lib/models"
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
import {saveCollection} from "@/app/c/[id]/save-collection"
import {formSchema} from "@/app/c/[id]/collection-edit-type"
import {useRouter} from "next/navigation"
import {TagSelector} from "@/components/tag-selector"


export function EditCollectionForm({collection}: { collection: Collection }) {
  const isSsr = useIsSsr()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      id: collection.id, // todo : make sure this can't be modified from client!
      name: collection.name,
      description: collection.description,
      tags: collection.tags || '',
      video: collection.metadata_?.video || '',
      session_date: collection.metadata_?.session_date || '',
      favorite: collection.favorite || false,
    },
  })

  if (isSsr) return null

  async function onSubmit(values: z.infer<typeof formSchema>) {
    // Do something with the form values.
    // ✅ This will be type-safe and validated.
    await saveCollection(values)

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
              <DialogTitle>Edit collection</DialogTitle>
              <DialogDescription>
                Make changes to the current collection here. Click save when you're done.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <FormField control={form.control}
                         name={'name'}
                         render={({field}) => (
                           <FormItem>
                             <FormLabel>Title</FormLabel>
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
                         name={'tags'}
                         render={({field}) => (
                           <FormItem>
                             <FormLabel>Tags</FormLabel>
                             <FormControl>
                               <TagSelector 
                                 userId={collection.user_id!}
                                 value={field.value || ''}
                                 onChange={field.onChange}
                               />
                             </FormControl>
                             <FormDescription>
                               Add tags to organize your collection. Select from recent tags or type new ones.
                             </FormDescription>
                           </FormItem>
                         )}
              />
              <FormField control={form.control}
                         name={'session_date'}
                         render={({field}) => (
                           <FormItem>
                             <FormLabel>Session Date</FormLabel>
                             <FormControl>
                               <Input type="date" {...field}/>
                             </FormControl>
                             <FormDescription>
                               Date of your observation session
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

/*
 */

//             <div className="grid grid-cols-4 items-center gap-4">
//               <Label htmlFor="name" className="text-right">
//                 Title
//               </Label>
//               <Input id="name" value={collection.name} className="col-span-3"/>
//             </div>
//             <div className="grid grid-cols-4 items-center gap-4">
//               <Label htmlFor="description" className="text-right">
//                 Description
//               </Label>
//               <Textarea id="description" placeholder="Add your description here...." className="col-span-3">
//                 {collection.description}
//               </Textarea>
//             </div>

/*
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="name" className="text-right">
                  Title
                </Label>
                <Input id="name" value={collection.name} className="col-span-3"/>
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="description" className="text-right">
                  Description
                </Label>
                <Textarea id="description" placeholder="Add your description here...." className="col-span-3">
                  {collection.description}
                </Textarea>
              </div>

 */
