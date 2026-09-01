"use client";

import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  LoaderCircle,
  Mail,
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

export function LoginForm({ initialError }: { initialError?: string }) {
  const [email, setEmail] = useState("");
  const [submittedEmail, setSubmittedEmail] = useState<string>();
  const [error, setError] = useState<string | undefined>(initialError);
  const [pending, setPending] = useState(false);
  const confirmationHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (submittedEmail) confirmationHeadingRef.current?.focus();
  }, [submittedEmail]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setPending(true);

    const normalizedEmail = email.trim().toLowerCase();
    const result = await authClient.signIn.magicLink({
      callbackURL: "/dashboard",
      email: normalizedEmail,
      errorCallbackURL: "/login",
      name: normalizedEmail.split("@")[0],
    });

    setPending(false);
    if (result.error) {
      setError(
        result.error.message ||
          "We could not send a sign-in link. Please try again.",
      );
      return;
    }

    setSubmittedEmail(normalizedEmail);
  }

  if (submittedEmail) {
    return (
      <Card className="w-full max-w-md shadow-xl shadow-foreground/5">
        <CardHeader className="pb-2">
          <div className="mb-4 grid size-11 place-items-center rounded-xl bg-accent text-accent-foreground">
            <CheckCircle2 className="size-5" />
          </div>
          <h1
            ref={confirmationHeadingRef}
            tabIndex={-1}
            className="font-heading text-2xl font-medium outline-none"
          >
            Check your inbox
          </h1>
          <CardDescription className="leading-6">
            We sent a one-time sign-in link to <strong>{submittedEmail}</strong>
            . It expires in 10 minutes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <Mail />
            <AlertTitle>Open the link on this device</AlertTitle>
            <AlertDescription>
              You can close this tab after the dashboard opens.
            </AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter>
          <Button
            type="button"
            variant="ghost"
            className="h-10 px-3"
            onClick={() => setSubmittedEmail(undefined)}
          >
            <ArrowLeft data-icon="inline-start" />
            Use a different email
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md shadow-xl shadow-foreground/5">
      <CardHeader className="pb-2">
        <h1 className="font-heading text-2xl font-medium">Sign in to Knot</h1>
        <CardDescription className="leading-6">
          Enter your invited email. No password is required.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-5" aria-busy={pending}>
          {error ? (
            <Alert id="sign-in-error" variant="destructive">
              <AlertTitle>Sign-in failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="email">Email address</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="you@company.com"
              required
              autoFocus
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "sign-in-error" : undefined}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-11"
              disabled={pending}
            />
          </div>
          <Button
            type="submit"
            className="h-11 w-full"
            disabled={pending}
            aria-busy={pending}
          >
            {pending ? (
              <>
                <LoaderCircle className="animate-spin" />
                Sending link…
              </>
            ) : (
              <>
                Continue with email
                <ArrowRight data-icon="inline-end" />
              </>
            )}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="justify-between gap-3 text-xs text-muted-foreground">
        <span>Invitation-only access</span>
        <Link
          href="/"
          className={cn(
            buttonVariants({ variant: "link", size: "sm" }),
            "px-0",
          )}
        >
          Back home
        </Link>
      </CardFooter>
    </Card>
  );
}
