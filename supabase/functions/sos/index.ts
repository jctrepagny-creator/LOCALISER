// Bouton SOS déclenché par un Raccourci iOS (widget sur l'écran d'accueil).
// Appel : POST https://<projet>.supabase.co/functions/v1/sos?k=<clé>
//         corps JSON { "lat": 48.8, "lon": 2.3 } (facultatif)
import { admin, corsHeaders, isAuthError, json } from "../_shared/common.ts";

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    const text = await req.text();
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        // corps « lat=…&lon=… » éventuel
        body = Object.fromEntries(new URLSearchParams(text));
      }
    }
  }
  const pick = (k: string) => body[k] ?? url.searchParams.get(k);
  const key = String(pick("k") ?? "");
  const lat = num(pick("lat"));
  const lon = num(pick("lon"));
  const acc = num(pick("acc"));

  const { data, error } = await admin.rpc("svc_ingest_sos", {
    p_key: key,
    p_lat: lat !== null && Math.abs(lat) <= 90 ? lat : null,
    p_lon: lon !== null && Math.abs(lon) <= 180 ? lon : null,
    p_acc: acc !== null ? Math.round(acc) : null,
  });

  if (error) {
    if (isAuthError(error)) return json({ ok: false, message: "Clé SOS invalide" }, 401);
    console.error("svc_ingest_sos", error);
    return json({ ok: false, message: "Erreur serveur, réessayez" }, 500);
  }
  return json({ ok: true, message: `Alerte envoyée à tes parents (${(data as { child: string }).child})` });
});
