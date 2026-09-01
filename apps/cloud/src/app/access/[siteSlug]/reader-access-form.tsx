"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ReaderAccessForm({ next }: { next: string }) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(formData: FormData) {
    setPending(true);
    setError(undefined);
    const response = await fetch("/api/v1/reader/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: formData.get("token") }),
    });
    if (!response.ok) {
      setPending(false);
      setError("This reader grant is expired, revoked, or already used.");
      return;
    }
    window.location.assign(next);
  }

  return (
    <form action={submit} className="mt-7 space-y-4">
      <div className="space-y-2">
        <Label htmlFor="reader-token">Reader grant</Label>
        <Input
          id="reader-token"
          name="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Checking…" : "Open site"}
      </Button>
    </form>
  );
}
