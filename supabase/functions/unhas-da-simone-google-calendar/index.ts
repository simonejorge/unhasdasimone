
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const GOOGLE_REDIRECT_URI = Deno.env.get("GOOGLE_REDIRECT_URI")!;
const CALENDAR_OWNER_EMAIL = "simonejorge@gmail.com";
const TIME_ZONE = "America/Sao_Paulo";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

class HttpError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 500, code = "INTERNAL_ERROR") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

// O Supabase/PostgREST retorna erros como objetos simples, não necessariamente
// como instâncias de Error. Esta função preserva a mensagem real do banco.
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    const parts = [value.message, value.details, value.hint, value.code]
      .filter((item) => item !== undefined && item !== null && String(item).trim() !== "")
      .map((item) => String(item));
    if (parts.length) return parts.join(" | ");
    try { return JSON.stringify(error); } catch { /* ignore */ }
  }
  return String(error ?? "Erro interno sem detalhes.");
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  normalized += "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
}

async function signState(payload: Record<string, unknown>) {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SERVICE_ROLE_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return `${toBase64Url(data)}.${toBase64Url(signature)}`;
}

async function verifyState(state: string) {
  try {
    const [encoded, signed] = state.split(".");
    if (!encoded || !signed) return null;
    const data = fromBase64Url(encoded);
    const signature = fromBase64Url(signed);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SERVICE_ROLE_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify("HMAC", key, signature, data);
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(data));
    if (!payload.uid || !payload.exp || payload.exp < Date.now()) return null;
    return payload as { uid: string; exp: number; return_url: string };
  } catch {
    return null;
  }
}

function safeReturnUrl(value: string | undefined) {
  const fallback = "https://unhasdasimone.site/admin.html";
  try {
    const url = new URL(value || fallback);
    const allowedHosts = ["unhasdasimone.site", "www.unhasdasimone.site", "simonejorge.github.io"];
    if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname)) return fallback;
    if (!url.pathname.endsWith("admin.html")) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

function redirectToPanel(returnUrl: string, status: "connected" | "error", message?: string) {
  const target = new URL(safeReturnUrl(returnUrl));
  target.searchParams.set("google_calendar", status);
  if (message) target.searchParams.set("google_calendar_message", message.slice(0, 180));
  return new Response(null, { status: 302, headers: { Location: target.toString() } });
}

// VALIDAÇÃO MASTER CORRIGIDA
async function requireMaster(req: Request) {
  const authorization = req.headers.get("Authorization") || "";
  const accessToken = authorization.replace(/^Bearer\s+/i, "");

  if (!accessToken) {
    throw new HttpError("Sessão não informada.", 401, "AUTH_REQUIRED");
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await userClient.auth.getUser(accessToken);

  if (error || !data.user) {
    throw new HttpError("Sessão inválida ou expirada.", 401, "AUTH_INVALID");
  }

  // Consulta pelo SERVICE ROLE para não depender das políticas RLS.
  const { data: admin, error: adminError } = await db
    .from("administradores")
    .select("perfil, ativo")
    .eq("usuario_id", data.user.id)
    .maybeSingle();

  if (adminError) {
    throw new HttpError(
      `Não foi possível validar as permissões do administrador: ${adminError.message}`,
      500,
      "ADMIN_LOOKUP_FAILED",
    );
  }

  if (
    !admin ||
    admin.ativo !== true ||
    String(admin.perfil).trim().toUpperCase() !== "MASTER"
  ) {
    throw new HttpError("Acesso permitido somente a administradores MASTER.", 403, "MASTER_REQUIRED");
  }

  return data.user.id;
}

// A agenda conectada é sempre a conta Simone.
async function getCalendarOwnerId() {
  const { data, error } = await db
    .from("administradores")
    .select("usuario_id")
    .ilike("email", CALENDAR_OWNER_EMAIL)
    .eq("perfil", "MASTER")
    .eq("ativo", true)
    .maybeSingle();

  if (error) {
    throw new HttpError(`Falha ao localizar a conta MASTER da Simone: ${error.message}`, 500, "CALENDAR_OWNER_LOOKUP_FAILED");
  }
  if (!data?.usuario_id) {
    throw new HttpError("Não encontrei o acesso MASTER ativo da Simone.", 500, "CALENDAR_OWNER_NOT_FOUND");
  }

  return data.usuario_id as string;
}

async function getGoogleAccessToken(ownerId: string) {
  const { data, error } = await db
    .from("google_calendar_tokens")
    .select("refresh_token")
    .eq("user_id", ownerId)
    .maybeSingle();

  if (error) {
    throw new HttpError(
      `Falha ao consultar o token Google salvo: ${describeError(error)}`,
      500,
      "GOOGLE_TOKEN_LOOKUP_FAILED",
    );
  }
  if (!data?.refresh_token) {
    throw new HttpError("A agenda Google da Simone ainda não está conectada. Reconecte a conta Google.", 409, "GOOGLE_NOT_CONNECTED");
  }

  const form = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: data.refresh_token,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });

  const result = await response.json();

  if (!response.ok || !result.access_token) {
    throw new Error(
      result.error_description || result.error || "Não foi possível renovar a autorização Google."
    );
  }

  return result.access_token as string;
}

async function googleRequest(accessToken: string, path: string, method = "GET", body?: unknown) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 204 || response.status === 410) return null;

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      result?.error?.message || `Google Calendar retornou HTTP ${response.status}.`
    );
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  return result;
}

function isoAtBrazilMidnight(date: string) {
  return new Date(`${date}T00:00:00-03:00`).toISOString();
}

async function syncAppointments(ownerId: string, accessToken: string, timeMin: string, timeMax: string) {
  const { data: rows, error } = await db
    .from("reservas")
    .select("id, inicio, fim, cliente_nome, cliente_whatsapp, servico_id, status, google_event_id")
    .gte("inicio", timeMin)
    .lt("inicio", timeMax)
    .order("inicio", { ascending: true });

  if (error) throw error;

  const serviceIds = [...new Set((rows || []).map((row) => row.servico_id).filter(Boolean))];
  const serviceNames = new Map<string, string>();

  if (serviceIds.length) {
    const { data: serviceRows, error: serviceError } = await db
      .from("servicos")
      .select("id, nome")
      .in("id", serviceIds);

    if (serviceError) throw serviceError;

    for (const service of serviceRows || []) {
      serviceNames.set(service.id, service.nome);
    }
  }

  let synced = 0;
  let removed = 0;
  let errors = 0;
  const messages: string[] = [];

  for (const booking of rows || []) {
    const active = ["agendado", "confirmado"].includes(booking.status);

    try {
      if (!active) {
        if (booking.google_event_id) {
          try {
            await googleRequest(
              accessToken,
              `calendars/primary/events/${encodeURIComponent(booking.google_event_id)}?sendUpdates=none`,
              "DELETE"
            );
          } catch (error) {
            const status = (error as Error & { status?: number }).status;
            if (status !== 404 && status !== 410) throw error;
          }

          await db
            .from("reservas")
            .update({ google_event_id: null, google_sync_status: "nao_aplicavel" })
            .eq("id", booking.id);

          removed++;
        }

        continue;
      }

      const serviceName = serviceNames.get(booking.servico_id) || "Atendimento";

      const event = {
        summary: `Unhas da Simone — ${serviceName} — ${booking.cliente_nome}`,
        description: [
          `Cliente: ${booking.cliente_nome}`,
          `WhatsApp: ${booking.cliente_whatsapp || "não informado"}`,
          `Serviço: ${serviceName}`,
          `Reserva: ${booking.id}`,
        ].join("\n"),
        start: { dateTime: booking.inicio, timeZone: TIME_ZONE },
        end: { dateTime: booking.fim, timeZone: TIME_ZONE },
        extendedProperties: {
          private: {
            source: "unhas-da-simone",
            reservation_id: booking.id,
          },
        },
      };

      let result: { id?: string } | null = null;

      if (booking.google_event_id) {
        try {
          result = await googleRequest(
            accessToken,
            `calendars/primary/events/${encodeURIComponent(booking.google_event_id)}?sendUpdates=none`,
            "PATCH",
            event
          );
        } catch (error) {
          const status = (error as Error & { status?: number }).status;
          if (status !== 404) throw error;
        }
      }

      if (!result) {
        result = await googleRequest(
          accessToken,
          "calendars/primary/events?sendUpdates=none",
          "POST",
          event
        );
      }

      if (!result?.id) {
        throw new Error("O Google não retornou o identificador do evento.");
      }

      const { error: updateError } = await db
        .from("reservas")
        .update({ google_event_id: result.id, google_sync_status: "sincronizado" })
        .eq("id", booking.id);

      if (updateError) throw updateError;

      synced++;
    } catch (error) {
      errors++;
      messages.push(`${booking.id}: ${describeError(error)}`);

      await db
        .from("reservas")
        .update({ google_sync_status: "erro" })
        .eq("id", booking.id);
    }
  }

  return {
    appointments_synced: synced,
    appointments_removed: removed,
    appointment_errors: errors,
    appointment_messages: messages.slice(0, 8),
  };
}

async function listGoogleEvents(accessToken: string, timeMin: string, timeMax: string) {
  const all: any[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "2500",
    });

    if (pageToken) params.set("pageToken", pageToken);

    const result = await googleRequest(
      accessToken,
      `calendars/primary/events?${params.toString()}`
    );

    all.push(...(result?.items || []));
    pageToken = result?.nextPageToken;
  } while (pageToken);

  return all;
}

async function syncPersonalBlocks(accessToken: string, timeMin: string, timeMax: string) {
  const { data: professional, error: professionalError } = await db
    .from("profissionais")
    .select("id")
    .eq("nome", "Simone Jorge")
    .eq("ativo", true)
    .maybeSingle();

  if (professionalError) {
    throw new HttpError(
      `Falha ao consultar a profissional Simone Jorge: ${describeError(professionalError)}`,
      500,
      "PROFESSIONAL_LOOKUP_FAILED",
    );
  }
  if (!professional?.id) {
    throw new HttpError("Não encontrei a profissional Simone Jorge para vincular os bloqueios.", 404, "PROFESSIONAL_NOT_FOUND");
  }

  const events = await listGoogleEvents(accessToken, timeMin, timeMax);
  const importedIds = new Set<string>();
  let imported = 0;
  let conflicts = 0;
  const blockMessages: string[] = [];

  for (const event of events) {
    if (!event.id || event.status === "cancelled" || event.transparency === "transparent") {
      continue;
    }

    if (event.extendedProperties?.private?.source === "unhas-da-simone") {
      continue;
    }

    const allDay = Boolean(event.start?.date && event.end?.date);

    const start = allDay
      ? isoAtBrazilMidnight(event.start.date)
      : event.start?.dateTime
        ? new Date(event.start.dateTime).toISOString()
        : null;

    const end = allDay
      ? isoAtBrazilMidnight(event.end.date)
      : event.end?.dateTime
        ? new Date(event.end.dateTime).toISOString()
        : null;

    if (!start || !end || new Date(end).getTime() <= new Date(start).getTime()) {
      continue;
    }

    importedIds.add(event.id);

    const payload = {
      profissional_id: professional.id,
      inicio: start,
      fim: end,
      motivo: (event.summary || "Compromisso pessoal").slice(0, 240),
      origem: "google",
      dia_inteiro: allDay,
      google_event_id: event.id,
    };

    const { error } = await db
      .from("bloqueios")
      .upsert(payload, { onConflict: "google_event_id" });

    if (error) {
      conflicts++;
      const detail = describeError(error);
      blockMessages.push(`${event.summary || event.id}: ${detail}`);
      console.error("[google-calendar] Falha ao importar bloqueio", {
        google_event_id: event.id,
        error: detail,
      });
      continue;
    }

    imported++;
  }

  const { data: existingBlocks, error: blocksError } = await db
    .from("bloqueios")
    .select("id, google_event_id")
    .eq("origem", "google")
    .lt("inicio", timeMax)
    .gt("fim", timeMin);

  if (blocksError) throw blocksError;

  const staleIds = (existingBlocks || [])
    .filter((block) => block.google_event_id && !importedIds.has(block.google_event_id))
    .map((block) => block.id);

  if (staleIds.length) {
    const { error: deleteError } = await db
      .from("bloqueios")
      .delete()
      .in("id", staleIds);

    if (deleteError) throw deleteError;
  }

  return {
    personal_blocks_synced: imported,
    block_conflicts: conflicts,
    block_messages: blockMessages.slice(0, 8),
    stale_blocks_removed: staleIds.length,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Retorno OAuth do Google.
  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const googleError = url.searchParams.get("error");

    if (!state) {
      return new Response("Parâmetro OAuth state ausente.", { status: 400 });
    }

    const payload = await verifyState(state);

    if (!payload) {
      return new Response(
        "Solicitação OAuth inválida ou expirada. Volte ao painel e tente novamente.",
        { status: 400 }
      );
    }

    if (googleError) {
      return redirectToPanel(payload.return_url, "error", "A autorização Google foi cancelada.");
    }

    if (!code) {
      return redirectToPanel(
        payload.return_url,
        "error",
        "O Google não retornou o código de autorização."
      );
    }

    const form = new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    });

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });

    const tokens = await tokenResponse.json();

    if (!tokenResponse.ok) {
      return redirectToPanel(
        payload.return_url,
        "error",
        tokens.error_description || tokens.error || "Falha ao trocar o código OAuth."
      );
    }

    let refreshToken = tokens.refresh_token as string | undefined;

    if (!refreshToken) {
      const { data: existing } = await db
        .from("google_calendar_tokens")
        .select("refresh_token")
        .eq("user_id", payload.uid)
        .maybeSingle();

      refreshToken = existing?.refresh_token;
    }

    if (!refreshToken) {
      return redirectToPanel(
        payload.return_url,
        "error",
        "Google não retornou o token de atualização. Tente conectar novamente."
      );
    }

    const { error: tokenError } = await db
      .from("google_calendar_tokens")
      .upsert({
        user_id: payload.uid,
        refresh_token: refreshToken,
        calendar_id: "primary",
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

    if (tokenError) {
      return redirectToPanel(payload.return_url, "error", tokenError.message);
    }

    const { error: integrationError } = await db
      .from("integracoes_google")
      .upsert({
        usuario_id: payload.uid,
        calendario_id: "primary",
        sincronizacao_ativa: true,
        ultima_sincronizacao: null,
        ultimo_erro: null,
        atualizado_em: new Date().toISOString(),
      }, { onConflict: "usuario_id" });

    if (integrationError) {
      return redirectToPanel(payload.return_url, "error", integrationError.message);
    }

    return redirectToPanel(payload.return_url, "connected");
  }

  if (req.method !== "POST") {
    return json({ error: "Método não permitido." }, 405);
  }

  let action = "unknown";
  let stage = "reading_request";
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError("Corpo da solicitação inválido. Envie um objeto JSON.", 400, "INVALID_BODY");
    }
    action = typeof body.action === "string" ? body.action : "unknown";

    // Consulta pública e somente de leitura: devolve apenas intervalos ocupados,
    // sem título, descrição, convidados ou qualquer dado pessoal do Google.
    // Limita cada consulta a um único dia e ao horizonte público de agendamento.
    if (action === "public_freebusy") {
      stage = "validating_public_freebusy_window";
      const timeMin = typeof body.timeMin === "string" ? body.timeMin : "";
      const timeMax = typeof body.timeMax === "string" ? body.timeMax : "";
      const minMs = Date.parse(timeMin);
      const maxMs = Date.parse(timeMax);
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;
      if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || maxMs <= minMs) {
        throw new HttpError("Informe um período válido para consultar a disponibilidade.", 400, "INVALID_FREEBUSY_WINDOW");
      }
      if (maxMs - minMs > 26 * 60 * 60 * 1000 || maxMs < now - oneDayMs || minMs > now + 61 * oneDayMs) {
        throw new HttpError("A consulta deve abranger apenas um dia dentro do período de agendamento.", 400, "FREEBUSY_WINDOW_OUT_OF_RANGE");
      }

      stage = "finding_calendar_owner_for_public_check";
      const publicOwnerId = await getCalendarOwnerId();
      stage = "refreshing_google_token_for_public_check";
      const publicAccessToken = await getGoogleAccessToken(publicOwnerId);
      stage = "querying_google_freebusy";
      const freebusy = await googleRequest(publicAccessToken, "freeBusy", "POST", {
        timeMin,
        timeMax,
        timeZone: TIME_ZONE,
        items: [{ id: "primary" }],
      });
      const calendar = freebusy?.calendars?.primary;
      if (calendar?.errors?.length) {
        throw new HttpError("O Google não conseguiu consultar a agenda principal.", 502, "GOOGLE_FREEBUSY_FAILED");
      }
      return json({ busy: Array.isArray(calendar?.busy) ? calendar.busy : [] });
    }

    stage = "validating_admin";
    await requireMaster(req);
    stage = "finding_calendar_owner";
    const ownerId = await getCalendarOwnerId();

    if (body.action === "connect") {
      const returnUrl = safeReturnUrl(body.return_url);

      const state = await signState({
        uid: ownerId,
        exp: Date.now() + 10 * 60 * 1000,
        nonce: crypto.randomUUID(),
        return_url: returnUrl,
      });

      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: GOOGLE_REDIRECT_URI,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
        access_type: "offline",
        prompt: "consent select_account",
        login_hint: CALENDAR_OWNER_EMAIL,
        include_granted_scopes: "true",
        state,
      });

      return json({
        authorization_url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      });
    }

    if (body.action === "status") {
      // O status de conexão depende somente da existência do token. Não precisa
      // renovar token nem chamar a API do Google, e não inicia sincronização.
      const { data: tokenRow, error: tokenError } = await db
        .from("google_calendar_tokens")
        .select("user_id")
        .eq("user_id", ownerId)
        .maybeSingle();

      if (tokenError) {
        throw new HttpError(
          `Falha ao consultar o registro de conexão Google: ${tokenError.message}`,
          500,
          "STATUS_TOKEN_LOOKUP_FAILED",
        );
      }

      // A tabela de integração guarda apenas o histórico. Se ela estiver
      // indisponível, ainda informamos corretamente se o token está conectado.
      const { data: integration, error: integrationError } = await db
        .from("integracoes_google")
        .select("ultima_sincronizacao, ultimo_erro")
        .eq("usuario_id", ownerId)
        .maybeSingle();

      return json({
        connected: Boolean(tokenRow),
        last_sync: integration?.ultima_sincronizacao ?? null,
        last_error: integration?.ultimo_erro ?? null,
        status_warning: integrationError
          ? `Conexão consultada, mas o histórico não pôde ser lido: ${integrationError.message}`
          : null,
      });
    }

    if (body.action === "disconnect") {
      const { error: tokenError } = await db
        .from("google_calendar_tokens")
        .delete()
        .eq("user_id", ownerId);

      if (tokenError) throw tokenError;

      const { error: integrationError } = await db
        .from("integracoes_google")
        .upsert({
          usuario_id: ownerId,
          calendario_id: "primary",
          sincronizacao_ativa: false,
          ultimo_erro: null,
          atualizado_em: new Date().toISOString(),
        }, { onConflict: "usuario_id" });

      if (integrationError) throw integrationError;

      return json({ disconnected: true });
    }

    stage = "refreshing_google_token";
    const accessToken = await getGoogleAccessToken(ownerId);

    if (body.action === "sync_all") {
      const timeMin = body.timeMin || new Date().toISOString();
      const timeMax = body.timeMax || new Date(
        Date.now() + 90 * 24 * 60 * 60 * 1000
      ).toISOString();

      if (new Date(timeMax).getTime() <= new Date(timeMin).getTime()) {
        throw new Error("Período de sincronização inválido.");
      }

      stage = "syncing_appointments";
      const appointments = await syncAppointments(
        ownerId,
        accessToken,
        timeMin,
        timeMax
      );

      stage = "syncing_personal_blocks";
      const personalBlocks = await syncPersonalBlocks(
        accessToken,
        timeMin,
        timeMax
      );

      const lastSync = new Date().toISOString();

      const summaryError = appointments.appointment_errors || personalBlocks.block_conflicts
        ? `${appointments.appointment_errors} erro(s) em atendimentos; ${personalBlocks.block_conflicts} conflito(s) de bloqueio.`
        : null;

      stage = "saving_sync_history";
      const { error: integrationError } = await db
        .from("integracoes_google")
        .upsert({
          usuario_id: ownerId,
          calendario_id: "primary",
          sincronizacao_ativa: true,
          ultima_sincronizacao: lastSync,
          ultimo_erro: summaryError,
          atualizado_em: lastSync,
        }, { onConflict: "usuario_id" });

      if (integrationError) throw integrationError;

      return json({
        ...appointments,
        ...personalBlocks,
        last_sync: lastSync,
      });
    }

    if (body.action === "freebusy") {
      if (!body.timeMin || !body.timeMax) {
        throw new Error("Informe timeMin e timeMax.");
      }

      const result = await googleRequest(accessToken, "freeBusy", "POST", {
        timeMin: body.timeMin,
        timeMax: body.timeMax,
        items: [{ id: "primary" }],
      });

      return json(result?.calendars?.primary ?? {});
    }

    if (body.action === "create_event" || body.action === "update_event") {
      const event = body.event;

      if (!event?.summary || !event?.start || !event?.end) {
        throw new Error("Informe título, início e fim do atendimento.");
      }

      const isUpdate = body.action === "update_event";

      if (isUpdate && !body.event_id) {
        throw new Error("Informe event_id.");
      }

      const path = isUpdate
        ? `calendars/primary/events/${encodeURIComponent(body.event_id)}?sendUpdates=none`
        : "calendars/primary/events?sendUpdates=none";

      const result = await googleRequest(
        accessToken,
        path,
        isUpdate ? "PATCH" : "POST",
        event
      );

      return json({ event: result });
    }

    if (body.action === "delete_event") {
      if (!body.event_id) {
        throw new Error("Informe event_id.");
      }

      await googleRequest(
        accessToken,
        `calendars/primary/events/${encodeURIComponent(body.event_id)}?sendUpdates=none`,
        "DELETE"
      );

      return json({ deleted: true });
    }

    throw new HttpError(`Ação não reconhecida: ${action}.`, 400, "UNKNOWN_ACTION");

  } catch (error) {
    const message = describeError(error);
    const status = error instanceof HttpError ? error.status : 500;
    const errorObject = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const code = error instanceof HttpError
      ? error.code
      : (typeof errorObject.code === "string" ? errorObject.code : "INTERNAL_ERROR");
    const details = typeof errorObject.details === "string" ? errorObject.details : null;
    const hint = typeof errorObject.hint === "string" ? errorObject.hint : null;
    console.error("[unhas-da-simone-google-calendar]", {
      action,
      stage,
      status,
      code,
      message,
      details,
      hint,
      error,
    });
    const visibleMessage = `${message} (etapa: ${stage}; código: ${code})`;
    return json({ error: visibleMessage, code, action, stage, details, hint }, status);
  }
});
