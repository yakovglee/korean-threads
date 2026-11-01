import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

async function signOut(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const target = request.nextUrl.clone();
  target.pathname = "/login";
  target.search = request.nextUrl.searchParams.has("denied") ? "?error=denied" : "";
  return NextResponse.redirect(target, { status: 303 });
}

// GET — когда адрес убрали из списка доступа, POST — кнопка «Выйти».
export const GET = signOut;
export const POST = signOut;
