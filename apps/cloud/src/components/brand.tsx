import Image from "next/image";
import Link from "next/link";

import { cn } from "@/lib/utils";

export function Brand({
  className,
  href = "/",
}: {
  className?: string;
  href?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex min-h-11 items-center gap-2.5 rounded-lg font-heading text-lg font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      <BrandMark />
      <span>Knot</span>
    </Link>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "relative grid size-8 shrink-0 place-items-center",
        className,
      )}
      aria-hidden="true"
    >
      <Image
        src="/brand/knot-flower.png"
        alt=""
        width={32}
        height={32}
        className="size-full scale-[1.6] object-contain"
      />
    </span>
  );
}
