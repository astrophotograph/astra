---
name: clerk-setup
description: Clerk auth setup details for astra.gallery — dev instance domain, JWT verification approach, and gotchas
type: project
---

Clerk app for astra.gallery uses dev instance `wired-walrus-5.accounts.dev` (NOT `.clerk.accounts.dev`).

**Why:** Clerk Account Portal sign-in URL uses `{instance}.accounts.dev`, not `{instance}.clerk.accounts.dev`.

**JWT verification:** Must use `jwtKey` (PEM public key) for networkless verification in Workers. The `secretKey`-based JWKS fetching fails from Workers with "Failed to resolve JWK" errors. PEM key is stored as `CLERK_JWT_KEY` Worker secret.

**How to apply:** When verifying Clerk JWTs in Workers, always use `verifyToken(token, { jwtKey: env.CLERK_JWT_KEY })`. The `__clerk_db_jwt` query param on redirects is a dev browser token, NOT a usable JWT — must use Clerk JS SDK `session.getToken()` to get a real JWT.

**Auto-registration:** Desktop sign-in auto-registers new users with username `astro-{timestamp}` if not yet registered.
