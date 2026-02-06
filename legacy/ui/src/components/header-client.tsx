"use client";

import {SignedIn, SignedOut, SignInButton, SignUpButton, UserButton} from "@clerk/nextjs"
import {useAuthMode} from "@/hooks/useAuthMode"

interface HeaderClientProps {
  initialIsSQLite: boolean;
}

export function HeaderClient({ initialIsSQLite }: HeaderClientProps) {
  const { isSQLite, isLoading } = useAuthMode();

  // Use the server-provided initial value while loading, then switch to client value
  const effectiveIsSQLite = isLoading ? initialIsSQLite : isSQLite;

  // Don't render auth buttons in SQLite mode or while loading
  if (effectiveIsSQLite || isLoading) {
    return null;
  }

  return (
    <>
      <li>
        <SignedOut>
          <SignInButton>
            <a href={"#"} className={'hover:text-neutral-300'}>Sign In</a>
          </SignInButton>
          <SignUpButton>
            <a href={"#"} className={'ml-4 hover:text-neutral-300'}>Sign Up</a>
          </SignUpButton>
        </SignedOut>
      </li>
      <li>
        <SignedIn>
          <UserButton/>
        </SignedIn>
      </li>
    </>
  );
}
