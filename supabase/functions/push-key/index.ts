// Renvoie la clé publique VAPID (notifications push web).
// Au premier appel, génère la paire de clés et mémorise l'URL des fonctions
// pour que la base puisse appeler `notify`.
import webpush from "npm:web-push@3.6.7";
import { admin, corsHeaders, json, SUPABASE_URL } from "../_shared/common.ts";

let cached: string | null = null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (cached) return json({ publicKey: cached });

  const keys = webpush.generateVAPIDKeys();
  const { data, error } = await admin.rpc("svc_ensure_settings", {
    p_functions_url: `${SUPABASE_URL}/functions/v1`,
    p_vapid_public: keys.publicKey,
    p_vapid_private: keys.privateKey,
  });
  if (error || !data) {
    console.error("svc_ensure_settings", error);
    return json({ error: "server" }, 500);
  }
  cached = data as string;
  return json({ publicKey: cached });
});
