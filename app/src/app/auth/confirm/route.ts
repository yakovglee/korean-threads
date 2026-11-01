import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Переход по ссылке из письма: обмениваем код (PKCE) или token_hash на сессию.
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const supabase = await createClient();

  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
      : { error: new Error("В ссылке нет кода") };

  const target = url.clone();
  target.search = "";
  target.pathname = error ? "/login" : "/";
  if (error) target.searchParams.set("error", "link");
  return NextResponse.redirect(target);
}
