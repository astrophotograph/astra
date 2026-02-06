import {clerkMiddleware} from '@clerk/nextjs/server'
import { NextResponse, NextRequest} from "next/server"
import { getDatabaseConfig } from '@/lib/database/config'

// Check if we're in SQLite mode
function isSQLiteMode(): boolean {
  try {
    const config = getDatabaseConfig();
    return config.dialect === 'sqlite';
  } catch (error) {
    console.error('Error checking SQLite mode in middleware:', error);
    return false;
  }
}

// Custom middleware that bypasses Clerk in SQLite mode
async function customMiddleware(req: NextRequest) {
  const newForward = req.headers.get("origin")?.replace(/(http|https):\/\//, "") || "*"
  const response = NextResponse.next()
  response.headers.set("x-forwarded-host", newForward)
  return response
}

export default function middleware(req: NextRequest) {
  // In SQLite mode, completely bypass Clerk middleware
  if (isSQLiteMode()) {
    return customMiddleware(req);
  }
  
  // In non-SQLite mode, use Clerk middleware
  return clerkMiddleware(async (auth, req) => {
    const newForward = req.headers.get("origin")?.replace(/(http|https):\/\//, "") || "*"
    const response = NextResponse.next()
    response.headers.set("x-forwarded-host", newForward)
    return response
  })(req);
}

// export default async function middleware(req: NextRequest) {
//   const newForward = req.headers.get("origin")?.replace(/(http|https):\/\//, "") || "*"
//   // console.debug("REQUEST HEADERS:::: ", req.headers)
//   // console.debug("NEW FORWARD:::: ", newForward)
//
//
//   const response = NextResponse.next()
//   response.headers.set("x-forwarded-host", newForward)
//   return response
//
//   // return actionHeaderCheckOverride(req)
//   // return actionHeaderCheckOverride(req, res, clerkMiddleware(async (auth, req) => {
//   //   return rewriteUserHome(req)
//   // }))
// }

// export default clerkMiddleware(async (auth, req) => {
//   return rewriteUserHome(req)
// })
// export default chainMiddleware();


// This function can be marked `async` if using `await` inside

// See "Matching Paths" below to learn more
// export const config = {
//   matcher: [
//     // Skip Next.js internals and all static files, unless found in search params
//     '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
//     // '/:path*',
//   ],
// }
