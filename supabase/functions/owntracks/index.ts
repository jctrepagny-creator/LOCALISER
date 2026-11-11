// Point d'entrée HTTP d'OwnTracks (iPhone des enfants).
// OwnTracks POSTe chaque message JSON avec une authentification Basic
// (identifiant/mot de passe générés par l'app parents). La réponse est un
// tableau JSON de commandes que l'app exécute (changement de mode, zones).
import { admin, basicAuth, isAuthError, json } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json([]);

  const cred = basicAuth(req);
  if (!cred) return json({ error: "auth" }, 401);

  const text = await req.text();
  if (!text.trim()) return json([]); // message vide (suppression d'ami) : ignoré

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text);
  } catch {
    return json({ error: "json" }, 400);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return json([]);
  }

  const { data, error } = await admin.rpc("svc_ingest_owntracks", {
    p_user: cred.user,
    p_secret: cred.pass,
    p_payload: payload,
  });

  if (error) {
    if (isAuthError(error)) return json({ error: "auth" }, 401);
    console.error("svc_ingest_owntracks", error);
    // 500 : OwnTracks garde le message en file et le renverra plus tard
    return json({ error: "server" }, 500);
  }
  return json(data ?? []);
});
