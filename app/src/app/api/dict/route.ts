import { NextResponse, type NextRequest } from "next/server";
import { getStudent } from "@/lib/auth";
import { wordCard } from "@/lib/krdict";

// Карточка слова из 한국어기초사전 по словарной форме: /api/dict?w=먹다
export async function GET(request: NextRequest) {
  if (!(await getStudent())) return NextResponse.json({ error: "Нужно войти" }, { status: 401 });
  const word = request.nextUrl.searchParams.get("w")?.trim();
  if (!word || word.length > 40) return NextResponse.json({ error: "Нет слова" }, { status: 400 });
  try {
    const card = await wordCard(word);
    return card
      ? NextResponse.json(card)
      : NextResponse.json({ error: "В словаре такого слова нет" }, { status: 404 });
  } catch (error) {
    console.error("dict", error);
    return NextResponse.json({ error: "Словарь сейчас недоступен" }, { status: 502 });
  }
}
