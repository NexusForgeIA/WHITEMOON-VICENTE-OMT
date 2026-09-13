// vomt-notify · Aviso de solicitud de contratación por Telegram.
// Solo acepta llamadas internas (vomt-chat) firmadas con la service role; nunca desde el navegador.
// TELEGRAM_BOT_TOKEN y VOMT_TELEGRAM_CHAT_ID (o TELEGRAM_CHAT_ID) viven en Supabase Secrets.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function igualSeguro(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const campo = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceRole || !igualSeguro(req.headers.get("authorization") ?? "", `Bearer ${serviceRole}`)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("VOMT_TELEGRAM_CHAT_ID") ?? Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    console.error(`[vomt-notify] faltan secrets: bot_token=${!!token} chat_id=${!!chatId}`);
    return json({ ok: false, error: "not_configured" }, 503);
  }

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const d = {
    nombre: campo(b.nombre),
    fecha: campo(b.fecha),
    ciudad: campo(b.ciudad),
    contacto: campo(b.contacto),
    detalles: campo(b.detalles, 600),
    origen: campo(b.origen, 120),
  };
  if (!d.nombre || !d.fecha || !d.ciudad || !d.contacto) return json({ ok: false, error: "faltan_datos" }, 400);

  const texto = [
    "🎧 VOMT · Nueva solicitud de contratación",
    "",
    `👤 ${d.nombre}`,
    `📅 ${d.fecha}`,
    `📍 ${d.ciudad}`,
    `📞 ${d.contacto}`,
    ...(d.detalles ? [`📝 ${d.detalles}`] : []),
    "",
    `Vía asistente IA de la web${d.origen ? ` (${d.origen})` : ""}`,
    "Booking: Sandra · sandra@mainanmusic.com · +34 663 953 036",
  ].join("\n");

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: texto, disable_web_page_preview: true }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      console.error(`[vomt-notify] telegram ${r.status} ${j.description ?? ""}`);
      return json({ ok: false, error: "telegram_error" }, 502);
    }
  } catch (e) {
    console.error("[vomt-notify] telegram", e instanceof Error ? e.message : e);
    return json({ ok: false, error: "telegram_unreachable" }, 502);
  }

  console.log(JSON.stringify({ fn: "vomt-notify", enviado: true }));
  return json({ ok: true });
});
