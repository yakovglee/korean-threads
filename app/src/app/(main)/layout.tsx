import Link from "next/link";
import { requireOnboardedStudent } from "@/lib/auth";
import { WordCardProvider } from "@/components/word-card";
import { NavLink } from "@/components/nav-link";

export default async function MainLayout({ children }: LayoutProps<"/">) {
  const student = await requireOnboardedStudent();

  return (
    <WordCardProvider>
      <header className="sticky top-0 z-40 border-b border-line bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-1 px-4 py-3">
          <Link href="/" className="mr-auto shrink-0 pr-2 font-bold">
            문법<span className="hidden font-normal text-muted sm:inline"> · Грамматика</span>
          </Link>
          <nav className="flex min-w-0 gap-0.5 overflow-x-auto [scrollbar-width:none]">
            <NavLink href="/">Лента</NavLink>
            <NavLink href="/bookmarks">Закладки</NavLink>
            <NavLink href="/search">Поиск</NavLink>
            <NavLink href="/profile">Профиль</NavLink>
            {student.isAdmin && <NavLink href="/admin">Админка</NavLink>}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">{children}</main>
    </WordCardProvider>
  );
}
