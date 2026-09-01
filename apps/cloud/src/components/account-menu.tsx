"use client";

import { LogOut, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";

export function AccountMenu({ email, name }: { email: string; name: string }) {
  const router = useRouter();
  const [signOutError, setSignOutError] = useState<string>();
  const initials = (name || email)
    .split(/[\s@._-]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        render={
          <Button variant="ghost" className="h-11 max-w-56 gap-2 px-2.5" />
        }
      >
        <Avatar className="size-7">
          <AvatarFallback className="bg-primary/12 text-xs font-semibold text-primary">
            {initials || <UserRound className="size-3.5" />}
          </AvatarFallback>
        </Avatar>
        <span className="hidden truncate text-sm sm:block">
          {name || email}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="py-2">
          <span className="block truncate font-medium text-foreground">
            {name || "Knot account"}
          </span>
          <span className="mt-0.5 block truncate font-normal">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {signOutError ? (
          <p className="px-2 py-1.5 text-xs text-destructive" role="alert">
            {signOutError}
          </p>
        ) : null}
        <DropdownMenuItem
          className="min-h-9 cursor-pointer"
          onClick={async () => {
            setSignOutError(undefined);
            const result = await authClient.signOut();
            if (result.error) {
              setSignOutError("Could not sign out. Please try again.");
              return;
            }
            router.push("/login");
            router.refresh();
          }}
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
