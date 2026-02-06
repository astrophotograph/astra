'use client'

import {Button} from "@/components/ui/button"
import {Table, TableBody, TableCaption, TableCell, TableRow} from "@/components/ui/table"
import {useState} from "react"
import {AstroObjectAction, fetchAstroObjectAction} from "@/lib/fetch-astro-object-action"
import {Dialog, DialogContent, DialogTitle, DialogTrigger} from "@/components/ui/dialog"

function CardDetails({state}: { state: AstroObjectAction | null }) {
  if (!state) {
    return null
  }

  return (
    <article className="space-y-1 prose prose-invert overflow-y-scroll max-h-[480px]">
      <DialogTitle className="text-sm font-semibold">{state.title}</DialogTitle>
      {!!state.description && (
        <p className="text-sm" dangerouslySetInnerHTML={{__html: state.description_html!}}></p>
      )}
      <Table>
        <TableCaption>Key facts about {state.display_name}</TableCaption>
        <TableBody>
          <TableRow>
            <TableCell className="font-medium">Object Type</TableCell>
            <TableCell className="text-right">{state.object_type}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="font-medium">Distance</TableCell>
            <TableCell className="text-right">{state.distance}</TableCell>
          </TableRow>
        </TableBody>
      </Table>

      {/*<div className="flex items-center pt-2">*/}
      {/*  /!*<CalendarIcon className="mr-2 h-4 w-4 opacity-70" />{" "}*!/*/}
      {/*  <span className="text-xs text-muted-foreground">*/}
      {/*    Joined December 2021*/}
      {/*  </span>*/}
      {/*</div>*/}
    </article>
  )

}


export function AnnotationCard({names}: { names: string[] }) {
  const name = names.join(" / ")
  const [state, setState] = useState<AstroObjectAction | null>(null)

  function setOpen(open: boolean) {
    if (open) {
      fetchAstroObjectAction(names[0]).then(response => {
        if (response) {
          setState(response)
        }
      })
    }
  }

  return (
    <Dialog onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="link" className={'text-white'}>{name}</Button>
      </DialogTrigger>
      <DialogContent className="bg-slate-700 text-slate-200">
        <div className="flex justify-between space-x-4 overflow-hidden">
          <CardDetails state={state}/>
        </div>
      </DialogContent>
    </Dialog>
  )

  // todo : when hovering on card, flag that object for highlighting in annotation!
  // return (
  //   <HoverCard onOpenChange={(open) => setOpen(open)}>
  //     <HoverCardTrigger asChild>
  //       <Button variant="link" className={'text-white'}>{name}</Button>
  //     </HoverCardTrigger>
  //     <HoverCardContent className="w-96 bg-slate-700 text-slate-200">
  //       <div className="flex justify-between space-x-4">
  //         {/*<Avatar>*/}
  //         {/*  <AvatarImage src="https://github.com/vercel.png" />*/}
  //         {/*  <AvatarFallback>VC</AvatarFallback>*/}
  //         {/*</Avatar>*/}
  //         <article className="space-y-1 prose prose-invert overflow-y-scroll max-h-96">
  //           <h4 className="text-sm font-semibold">{state.title}</h4>
  //           {/*<p className="text-sm">*/}
  //           {/*  {state.title}*/}
  //           {/*</p>*/}
  //           {!!state.description && (
  //             <p className="text-sm" dangerouslySetInnerHTML={{__html: state.description_html}}></p>
  //           )}
  //           <Table>
  //             <TableCaption>Key facts about {state.display_name}</TableCaption>
  //             <TableBody>
  //               <TableRow>
  //                 <TableCell className="font-medium">Object Type</TableCell>
  //                 <TableCell className="text-right">{state.object_type}</TableCell>
  //               </TableRow>
  //               <TableRow>
  //                 <TableCell className="font-medium">Distance</TableCell>
  //                 <TableCell className="text-right">{state.distance}</TableCell>
  //               </TableRow>
  //             </TableBody>
  //           </Table>
  //
  //           {/*<div className="flex items-center pt-2">*/}
  //           {/*  /!*<CalendarIcon className="mr-2 h-4 w-4 opacity-70" />{" "}*!/*/}
  //           {/*  <span className="text-xs text-muted-foreground">*/}
  //           {/*    Joined December 2021*/}
  //           {/*  </span>*/}
  //           {/*</div>*/}
  //         </article>
  //       </div>
  //     </HoverCardContent>
  //   </HoverCard>
  //
  // )

}
