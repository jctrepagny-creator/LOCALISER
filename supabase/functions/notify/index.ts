// Appelée par la base (déclencheur sur `events`, via pg_net) :
// envoie la notification push à tous les appareils parents/proches abonnés.
import webpush from "npm:web-push@3.6.7";
import { admin, json, SUPABASE_URL } from "../_shared/common.ts";

type Payload = {
  event: {
    id: number;
    type: string;
    title: string;
    body: string;
    child_id: string | null;
    lat: number | null;
    lon: number | null;
  };
  vapid_public: string;
  vapid_private: string;
  subscriptions: { endpoint: string; p256dh: string; auth: string }[];
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const secret = req.headers.get("x-internal-secret") ?? "";
  let eventId: number;
  try {
    eventId = Number((await req.json()).event_id);
  } catch {
    return json({ error: "json" }, 400);
  }

  const { data, error } = await admin.rpc("svc_notify_payload", {
    p_event_id: eventId,
    p_secret: secret,
  });
  if (error) {
    return json({ error: "forbidden" }, 403);
  }
  if (!data) return json({ sent: 0 });
  const p = data as Payload;
  if (!p.vapid_public || !p.vapid_private) return json({ sent: 0, reason: "no-vapid" });

  webpush.setVapidDetails(`mailto:localiser@${new URL(SUPABASE_URL).hostname}`, p.vapid_public, p.vapid_private);

  const message = JSON.stringify({
    title: p.event.title,
    body: p.event.body,
    type: p.event.type,
    child_id: p.event.child_id,
    event_id: p.event.id,
  });
  const urgent = p.event.type === "sos";

  let sent = 0;
  await Promise.all(p.subscriptions.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        message,
        { TTL: urgent ? 3600 : 6 * 3600, urgency: urgent ? "high" : "normal" },
      );
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // abonnement expiré (app désinstallée, notifications coupées…)
        await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      } else {
        console.error("push", status, (e as Error).message);
      }
    }
  }));
  return json({ sent });
});
