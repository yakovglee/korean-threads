"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" || path.startsWith("/t/") : path.startsWith(href);
  return (
    <Link
      href={href}
      className={`shrink-0 rounded-full px-2.5 py-1 text-sm sm:px-3 ${active ? "bg-surface font-medium" : "text-muted hover:text-foreground"}`}
    >
      {children}
    </Link>
  );
}
