import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {User} from "@/lib/models"
import Config from "@/lib/config"

export function DefaultBreadcrumb({user, pageName}: { user?: User, pageName: string }) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="/">Home</BreadcrumbLink>
        </BreadcrumbItem>
        {!Config.singleUser && user && (
          <>
            <BreadcrumbSeparator/>
            <BreadcrumbItem>
              <BreadcrumbLink href={`/u/${user.id}`}>{user.name}</BreadcrumbLink>
            </BreadcrumbItem>
          </>
        )}
        <BreadcrumbSeparator/>
        <BreadcrumbItem>
          <BreadcrumbPage>{pageName}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>

  )

}
