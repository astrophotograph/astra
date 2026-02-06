import {NextRequest, NextResponse, NextFetchEvent} from "next/server"
import {clerkMiddleware} from "@clerk/nextjs/server"
import Config from "@/lib/config"

export type ChainableMiddleware = (
  request: NextRequest,
  event: NextFetchEvent,
) => Promise<NextResponse>

export type MiddlewareFactory = (middleware: ChainableMiddleware) => ChainableMiddleware

export function chainMiddleware(
  functions: MiddlewareFactory[] = [],
  index = 0,
): ChainableMiddleware {
  const current = functions[index]
  if (current) {
    const next = chainMiddleware(functions, index + 1)
    return current(next)
  }

  return async (request) => NextResponse.next({request})
}

// export const clearkChainedMiddleware: MiddlewareFactory = (next:ChainableMiddleware) => {
//
//   return async (request: NextRequest, event: NextFetchEvent) => {
//     const response = await clerkMiddleware(request, event)
//     if (response) {
//       return response
//     }
//     return next(request, event)
//
//   }
// }

export const rewriteUserHome2= (next: ChainableMiddleware) => {
  return async (request: NextRequest, event: NextFetchEvent) => {
    // request.headers.forEach((value, name) => {
    //   console.log(name, value)
    // })
    // console.log(request.url)
    //
    const host = request.headers.get('host')
    const path = request.nextUrl.pathname

    if (Config.singleUser && path === '/' && host?.startsWith(Config.singleUserHost())) {
      return NextResponse.rewrite(new URL(`/u/${Config.singleUserId()}`, request.url), { request })
    }

    return next(request, event)
  }
}

export async function rewriteUserHome(request: NextRequest) {
  // request.headers.forEach((value, name) => {
  //   console.log(name, value)
  // })
  // console.log(request.url)
  //
  const host = request.headers.get('host')
  const path = request.nextUrl.pathname

  console.log('host', host)
  console.log('path', path)

  if (Config.singleUser && path === '/' && host?.startsWith(Config.singleUserHost())) {
    return NextResponse.rewrite(new URL(`/u/${Config.singleUserId()}`, request.url), { request })
  }

  return NextResponse.next({ request })
}
