// vomt-chat · Asistente IA de la web de Vicente One More Time.
// Claude lee la agenda real (vomt_eventos, solo publicados desde hoy) y, en contratación,
// avisa al equipo de booking por Telegram a través de vomt-notify.
// La ANTHROPIC_API_KEY vive SOLO en Supabase Secrets.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.125.0";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 450;
const MAX_HISTORY = 12;
const MAX_CHARS = 1000;
const BOOKING = "Sandra · sandra@mainanmusic.com · +34 663 953 036";
const FALLBACK = `Ahora mismo no puedo responder. Para contrataciones escribe a ${BOOKING}.`;

const ORIGENES = new Set([
  "https://nexusforgeia.github.io",
  "https://vicenteonemoretime.com",
  "https://www.vicenteonemoretime.com",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin && ORIGENES.has(origin) ? origin : "https://nexusforgeia.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

// Límite básico por IP (memoria de la instancia): frena abusos del endpoint público.
const VENTANA_MS = 10 * 60 * 1000;
const LIMITE = 30;
const hits = new Map<string, { n: number; hasta: number }>();
function limitado(ip: string): boolean {
  const ahora = Date.now();
  const h = hits.get(ip);
  if (!h || h.hasta < ahora) {
    hits.set(ip, { n: 1, hasta: ahora + VENTANA_MS });
    return false;
  }
  h.n++;
  return h.n > LIMITE;
}

type Evento = {
  fecha: string;
  nombre: string;
  sala: string | null;
  ciudad: string | null;
  ticket_url: string | null;
  destacado: boolean;
};

async function proximosEventos(hoy: string): Promise<Evento[]> {
  const url = new URL(`${Deno.env.get("SUPABASE_URL")}/rest/v1/vomt_eventos`);
  url.searchParams.set("select", "fecha,nombre,sala,ciudad,ticket_url,destacado");
  url.searchParams.set("estado", "eq.publicado");
  url.searchParams.set("fecha", `gte.${hoy}`);
  url.searchParams.set("order", "fecha.asc");
  url.searchParams.set("limit", "20");
  const key = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  // Clave anon: el RLS solo deja leer lo publicado (mínimo privilegio).
  const r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`agenda HTTP ${r.status}`);
  return await r.json();
}

const fechaLarga = (f: string) =>
  new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${f}T00:00:00Z`));

function systemPrompt(eventos: Evento[], hoy: string, agendaOk: boolean): string {
  const agenda = !agendaOk
    ? "(La agenda no se ha podido cargar ahora mismo. No afirmes que no hay fechas: recomienda mirar la sección Agenda de la web o el Instagram de Vicente.)"
    : eventos.length
    ? eventos.map((e) =>
      `- ${fechaLarga(e.fecha)}: ${e.nombre}${e.sala ? ` · ${e.sala}` : ""}${e.ciudad ? ` · ${e.ciudad}` : ""}` +
      ` · Entradas: ${e.ticket_url ?? "aún no a la venta"}${e.destacado ? " · destacado" : ""}`
    ).join("\n")
    : "(No hay eventos publicados de hoy en adelante.)";

  return `Eres el asistente de la web oficial de Vicente One More Time, DJ y productor de hardstyle. Hablas con fans, promotores y salas. Hoy es ${fechaLarga(hoy)} (hora de Madrid).

<artista>
- Más de 20 años dedicado a la música dance, progressive y hardstyle.
- Residente de la sesión Hardstyle 150 en Fabrik (Madrid) y director de UNIKA FM.
- Ha compartido cabina con Showtek, Brennan Heart, Da Tweekaz, Wildstylez, Headhunterz, Steve Aoki, Martin Garrix y Angerfist, entre otros.
- "Musika" fue el mejor tema progressive del año 2000 (DJ Magazine) y "Yambo" el mejor disco de 2003 en España (DJ ONE).
- Mejor Artista Hardstyle en los Vicious Music Awards 2014 y 2015. Pionero en llevar el hardstyle a Ibiza.
- Ha pinchado en Fabrik, Dreambeach, Medusa Sunbeach, In-Qontrol (Holanda), Amnesia (Suiza), Animal Sound, 4Every1 Festival y Techno House Festival.
- Temas: Musika Maestro, Bailar Sin Parar, Chalaos, Desastre Nuclear, El Sonido de los Druidas, Esto No Es Bambi y La Noche Te Equivoca.
- Redes y música: Instagram https://www.instagram.com/vicenteonemoretime/ · Facebook https://www.facebook.com/vicenteonemoretime/ · X https://x.com/vicente_omt · SoundCloud https://soundcloud.com/vicenteonemoretime · Spotify https://open.spotify.com/artist/2fBNX2F6x9P2tdJGKbTaPa · YouTube https://www.youtube.com/@vicenteomt
- Booking y management: ${BOOKING}
</artista>

<agenda>
${agenda}
</agenda>

Cómo responder:
- Máximo 3 frases por respuesta y como mucho una pregunta. Tono cercano y con energía, sin exagerar; como mucho un emoji.
- Texto plano: el chat no muestra markdown, así que nada de asteriscos ni almohadillas. Si enumeras bolos, pon uno por línea empezando por "• ".
- Responde en el idioma en que te escriban.
- Fechas, salas, ciudades y enlaces de entradas: usa solo lo que aparece en <agenda>. No inventes ni supongas fechas, precios, cachés, horarios ni line-ups; si algo no está aquí, dilo y deriva a Instagram o a Sandra.
- Si la agenda dice que no hay eventos publicados, dilo claramente y recomienda seguir a Vicente en Instagram.
- Si un evento no tiene enlace de entradas, di que aún no están a la venta.
- Cachés, condiciones y disponibilidad para contratar no los das tú: los gestiona Sandra.

Contratación (bolos, festivales, salas, eventos privados):
- Pide, de uno en uno, los datos que falten de estos cuatro: nombre (persona o empresa), fecha del evento, ciudad y un contacto (email o teléfono). No vuelvas a pedir lo que el usuario ya haya dado.
- En cuanto tengas los cuatro, usa la herramienta registrar_contratacion una sola vez y después confirma que el equipo de booking le contactará, dando también el contacto directo de Sandra.
- Si el usuario prefiere no dar sus datos, dale el contacto de Sandra.`;
}

const TOOLS: Anthropic.Tool[] = [{
  name: "registrar_contratacion",
  description:
    "Envía al equipo de booking de Vicente (Sandra) una solicitud de contratación por Telegram. Úsala solo cuando ya tengas nombre, fecha, ciudad y contacto del solicitante.",
  input_schema: {
    type: "object",
    properties: {
      nombre: { type: "string", description: "Nombre de la persona o empresa que quiere contratar" },
      fecha: { type: "string", description: "Fecha o fechas del evento, tal como las ha dado el usuario" },
      ciudad: { type: "string", description: "Ciudad o lugar del evento" },
      contacto: { type: "string", description: "Email o teléfono de contacto" },
      detalles: { type: "string", description: "Tipo de evento, sala, aforo u otros datos que haya dado (opcional)" },
    },
    required: ["nombre", "fecha", "ciudad", "contacto"],
  },
}];

function limpiarHistorial(raw: unknown): Anthropic.MessageParam[] | null {
  if (!Array.isArray(raw)) return null;
  const msgs: Anthropic.MessageParam[] = raw
    .filter((m): m is { role: "user" | "assistant"; content: string } =>
      !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim() !== ""
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }))
    .slice(-MAX_HISTORY);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return null;
  return msgs;
}

async function avisarBooking(input: Record<string, unknown>, origen: string | null): Promise<boolean> {
  const campo = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim().slice(0, 300) : "");
  const datos = {
    nombre: campo("nombre"),
    fecha: campo("fecha"),
    ciudad: campo("ciudad"),
    contacto: campo("contacto"),
    detalles: campo("detalles"),
    origen: origen ?? "",
  };
  if (!datos.nombre || !datos.fecha || !datos.ciudad || !datos.contacto) return false;
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/vomt-notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify(datos),
    });
    if (!r.ok) console.error(`[vomt-chat] vomt-notify HTTP ${r.status}`);
    return r.ok;
  } catch (e) {
    console.error("[vomt-chat] vomt-notify", e instanceof Error ? e.message : e);
    return false;
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "anon";
  if (limitado(ip)) return json({ error: "rate_limited", reply: "Vas muy rápido. Espera un momento y vuelve a escribirme." }, 429);

  let body: { messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const messages = limpiarHistorial(body.messages);
  if (!messages) return json({ error: "invalid_messages" }, 400);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("[vomt-chat] falta ANTHROPIC_API_KEY en Secrets");
    return json({ error: "not_configured", reply: FALLBACK }, 503);
  }

  const t0 = Date.now();
  const hoy = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
  let eventos: Evento[] = [];
  let agendaOk = true;
  try {
    eventos = await proximosEventos(hoy);
  } catch (e) {
    agendaOk = false;
    console.error("[vomt-chat] agenda", e instanceof Error ? e.message : e);
  }

  const client = new Anthropic({ apiKey });
  const system = systemPrompt(eventos, hoy, agendaOk);

  try {
    let resp = await client.messages.create({ model: MODEL, max_tokens: MAX_TOKENS, system, tools: TOOLS, messages });
    let lead = false;

    if (resp.stop_reason === "tool_use") {
      const usos = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const resultados: Anthropic.ToolResultBlockParam[] = [];
      for (const uso of usos) {
        const ok = uso.name === "registrar_contratacion" &&
          await avisarBooking(uso.input as Record<string, unknown>, origin);
        lead = lead || ok;
        resultados.push({
          type: "tool_result",
          tool_use_id: uso.id,
          content: ok
            ? "Solicitud enviada al equipo de booking."
            : `No se ha podido enviar el aviso. Pide al usuario que escriba directamente a ${BOOKING}.`,
          is_error: !ok,
        });
      }
      resp = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        tools: TOOLS,
        tool_choice: { type: "none" },
        messages: [...messages, { role: "assistant", content: resp.content }, { role: "user", content: resultados }],
      });
    }

    const reply = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    // Log sin datos personales: solo métricas de la llamada.
    console.log(JSON.stringify({
      fn: "vomt-chat",
      eventos: eventos.length,
      agenda_ok: agendaOk,
      turnos: messages.length,
      lead,
      stop: resp.stop_reason,
      tokens_in: resp.usage.input_tokens,
      tokens_out: resp.usage.output_tokens,
      ms: Date.now() - t0,
    }));
    return json({ reply: reply || FALLBACK, lead });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      console.error("[vomt-chat] Anthropic 429");
      return json({ error: "upstream_busy", reply: "Ahora mismo hay mucha gente preguntando. Inténtalo en un minuto." }, 503);
    }
    if (e instanceof Anthropic.APIError) {
      console.error(`[vomt-chat] Anthropic ${e.status} ${e.message}`);
      return json({ error: "upstream_error", reply: FALLBACK }, 502);
    }
    console.error("[vomt-chat] error", e instanceof Error ? e.message : e);
    return json({ error: "server_error", reply: FALLBACK }, 500);
  }
});
