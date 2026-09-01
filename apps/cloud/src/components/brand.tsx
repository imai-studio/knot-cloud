import Image from "next/image";
import Link from "next/link";

import { cn } from "@/lib/utils";

export function Brand({
  className,
  href = "/",
  bare = false,
}: {
  className?: string;
  href?: string;
  bare?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex min-h-11 items-center gap-2.5 rounded-lg font-heading text-lg font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      <BrandMark bare={bare} />
      <span>Knot</span>
    </Link>
  );
}

export function BrandMark({
  className,
  bare = false,
}: {
  className?: string;
  bare?: boolean;
}) {
  return (
    <span
      className={cn(
        "relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-white shadow-none ring-1 ring-black/8 dark:ring-white/10",
        bare && "rounded-none bg-transparent shadow-none ring-0 dark:ring-0",
        className,
      )}
      aria-hidden="true"
    >
      <Image
        src="/brand/knot-flower.png"
        alt=""
        width={32}
        height={32}
        className={cn("size-full object-cover", bare && "mix-blend-multiply")}
      />
    </span>
  );
}
