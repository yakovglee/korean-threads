import Link from "next/link";
import type { TagView } from "@/lib/types";

export function tagLabel(tag: TagView) {
  return tag.kind === "word" ? `단어: ${tag.value}` : tag.value;
}

export function TagChip({ tag, active = false }: { tag: TagView; active?: boolean }) {
  return (
    <Link
      href={active ? "/" : `/?tag=${encodeURIComponent(tag.value)}`}
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ${
        active ? "bg-foreground text-background" : "bg-surface text-muted hover:text-foreground"
      }`}
    >
      {tagLabel(tag)}
      {tag.level && <span className="opacity-60">{tag.level}</span>}
    </Link>
  );
}
