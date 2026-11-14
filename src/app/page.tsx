import { Feed } from "@/components/Feed";

/**
 * Лента владельца. В демо роль задаёт маршрут: `/` для владельца, `/viewer` для зрителя.
 * В боевой версии роль определяет сессия (П-54, П-68).
 */
export default function Home() {
  return <Feed viewer={false} />;
}
