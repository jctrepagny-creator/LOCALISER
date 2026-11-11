import { createClient } from "npm:@supabase/supabase-js@2.118.0";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

/** Client « service » : contourne la RLS, réservé au serveur. */
export const admin = createClient(
  SUPABASE_URL,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Décode un en-tête « Authorization: Basic … ». */
export function basicAuth(req: Request): { user: string; pass: string } | null {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(match[1].trim()), (c) => c.charCodeAt(0)),
    );
    const sep = decoded.indexOf(":");
    if (sep < 0) return null;
    return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

/** Code SQLSTATE 28000 levé par les RPC quand l'identifiant est faux. */
export function isAuthError(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === "28000" || /invalid_credentials|forbidden/.test(error.message ?? ""));
}
