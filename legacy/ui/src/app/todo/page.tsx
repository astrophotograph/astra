import {AstronomyTodoList} from "@/components/astronomy-todo-list"
import {DefaultBreadcrumb} from "@/components/default-breadcrumb"
import {fetchUser} from "@/lib/db"

// todo:
// - date to track when added and imaged.  (checkbox).  filter to show completed
// - add notes on target
// - write to database table after writing to local storage
export default async function AstronomyTodoPage({
                                                  params,
                                                }: {
                                                  params: Promise<{ id: string }>
                                                },
) {
  const {id} = await params
  const user = await fetchUser(id)

  return (
    <main className="container mx-auto py-8 flex-grow relative">
      <DefaultBreadcrumb user={user!} pageName="Astronomy Todo List"/>
      <h3 className="text-2xl font-semibold my-6">Astronomy Objects Todo List</h3>
      <p className="mb-6">
        Keep track of celestial objects you want to observe. Add objects to your list and
        remove them once you&apos;ve completed your observation.
      </p>
      <AstronomyTodoList/>
    </main>
  )
}
