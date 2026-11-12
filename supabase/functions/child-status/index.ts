// État d'un enfant pour la page d'installation sur son iPhone.
// GET /functions/v1/child-status?k=<utilisateur>:<secret>
import { admin, corsHeaders, isAuthError, json } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const key = new URL(req.url).searchParams.get("k") ?? "";
  const { data, error } = await admin.rpc("svc_child_status", { p_key: key });
  if (error) {
    if (isAuthError(error)) return json({ error: "Clé invalide : regénérez le QR code depuis l'app des parents." }, 401);
    console.error("svc_child_status", error);
    return json({ error: "Erreur serveur" }, 500);
  }
  return json(data);
});
