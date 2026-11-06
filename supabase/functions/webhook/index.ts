// Единая точка приёма сообщений из соцсетей.
//   /functions/v1/webhook/<channel_id>  Telegram, Viber, VK: у каждого канала свой адрес
//   /functions/v1/webhook/meta          Instagram, Facebook, WhatsApp: один адрес на приложение Meta
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { adapters } from "../_shared/adapters/index.ts";
import { type MetaRoutedEvent, parseMeta } from "../_shared/adapters/meta.ts";
import { parseTelegram } from "../_shared/adapters/telegram.ts";
import { parseViber } from "../_shared/adapters/viber.ts";
import { parseVk } from "../_shared/adapters/vk.ts";
import { hmacSha256Hex, safeEqual } from "../_shared/crypto.ts";
import { type ChannelRow, credentialsOf, deliver, loadSecrets, recordChannelError, type SecretsRow, serviceClient } from "../_shared/db.ts";
import { META_PLATFORMS, type Credentials, type InboundEvent } from "../_shared/types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = (body = "ok") => new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });

async function processEvent(db: SupabaseClient, channel: ChannelRow, creds: Credentials, event: InboundEvent) {
  const adapter = adapters[channel.platform];

  if (event.kind === "owner_message") {
    const { error } = await db.rpc("bot_record_owner_message", {
      p_channel_id: channel.id,
      p_external_user_id: event.externalUserId,
      p_external_message_id: event.messageId,
      p_text: event.text ?? null,
    });
    if (error) throw error;
    return;
  }

  await event.ack?.(creds);

  const { data, error } = await db.rpc("bot_handle_inbound", {
    p_channel_id: channel.id,
    p_external_user_id: event.externalUserId,
    p_external_message_id: event.messageId,
    p_text: event.text ?? null,
    p_option_id: event.optionId ?? null,
    p_display_name: event.displayName ?? null,
    p_username: event.username ?? null,
    p_contact_meta: event.contactMeta ?? {},
    p_attachment: event.attachment ?? null,
  });
  if (error) throw error;
  if (data.ignored || data.duplicate) return;

  await deliver(
    db,
    adapter,
    {
      creds,
      channelName: channel.name,
      contact: { externalId: event.externalUserId, meta: event.contactMeta },
    },
    data.outbound,
  );

  if (data.new_contact && adapter.fetchProfile && !event.displayName) {
    // Имя в профиле не обязательно для опроса, поэтому ошибка здесь ни на что не влияет.
    const profile = await adapter.fetchProfile(creds, event.externalUserId).catch(() => null);
    if (profile?.displayName || profile?.username) {
      await db.from("contacts").update({
        display_name: profile.displayName ?? null,
        username: profile.username ?? null,
      }).eq("channel_id", channel.id).eq("external_id", event.externalUserId);
    }
  }
}

async function handleChannel(req: Request, db: SupabaseClient, channelId: string): Promise<Response> {
  if (!UUID.test(channelId)) return new Response("not found", { status: 404 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const { data: channel, error } = await db.from("channels").select("*").eq("id", channelId).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  if (!channel || META_PLATFORMS.includes(channel.platform)) return new Response("not found", { status: 404 });

  const secrets = await loadSecrets(db, channel.id);
  if (!secrets) return new Response("not found", { status: 404 });

  const raw = new Uint8Array(await req.arrayBuffer());
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const creds = await credentialsOf(secrets);

  let events: InboundEvent[] = [];
  switch (channel.platform) {
    case "telegram": {
      const header = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!safeEqual(header, secrets.webhook_secret)) return new Response("forbidden", { status: 401 });
      events = parseTelegram(body);
      break;
    }
    case "viber": {
      const signature = req.headers.get("x-viber-content-signature") ?? "";
      if (!safeEqual(signature, await hmacSha256Hex(creds.token, raw))) return new Response("forbidden", { status: 401 });
      if (body.event === "conversation_started") {
        // Единственное сообщение, которое Viber разрешает до подписки клиента, отдаётся прямо в ответе.
        return new Response(JSON.stringify({
          sender: { name: channel.name.slice(0, 28) },
          type: "text",
          text: "Здравствуйте! Напишите любое сообщение, и мы начнём.",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      events = parseViber(body);
      break;
    }
    case "vk": {
      if (String(body.group_id) !== String(channel.external_id)) return new Response("forbidden", { status: 401 });
      if (body.type === "confirmation") return ok(String(secrets.extra?.vk_confirmation ?? ""));
      if (!safeEqual(String(body.secret ?? ""), secrets.webhook_secret.slice(0, 50))) {
        return new Response("forbidden", { status: 401 });
      }
      events = parseVk(body);
      break;
    }
  }

  for (const event of events) await processEvent(db, channel, creds, event);
  return ok();
}

async function handleMetaVerification(url: URL, db: SupabaseClient): Promise<Response> {
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (url.searchParams.get("hub.mode") !== "subscribe" || !token) return new Response("forbidden", { status: 403 });

  const { data, error } = await db.from("channel_secrets").select("channel_id").eq("webhook_secret", token).maybeSingle();
  if (error) throw error;
  if (!data) return new Response("forbidden", { status: 403 });

  const { data: channel } = await db.from("channels").select("platform").eq("id", data.channel_id).is("deleted_at", null).maybeSingle();
  if (!channel || !META_PLATFORMS.includes(channel.platform)) return new Response("forbidden", { status: 403 });
  return ok(challenge);
}

async function handleMetaEvents(req: Request, db: SupabaseClient): Promise<Response> {
  const raw = new Uint8Array(await req.arrayBuffer());
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const routed = parseMeta(body);
  const byAccount = new Map<string, MetaRoutedEvent[]>();
  for (const item of routed) {
    const key = `${item.platform}:${item.routeId}`;
    byAccount.set(key, [...(byAccount.get(key) ?? []), item]);
  }

  const signature = req.headers.get("x-hub-signature-256")?.replace(/^sha256=/, "") ?? "";
  let rejected = false;

  for (const items of byAccount.values()) {
    const { platform, routeId } = items[0];
    const { data: channel, error } = await db.from("channels").select("*")
      .eq("platform", platform).eq("external_id", routeId).is("deleted_at", null).maybeSingle();
    if (error) throw error;
    if (!channel) continue;

    const secrets: SecretsRow | null = await loadSecrets(db, channel.id);
    if (!secrets) continue;
    const creds = await credentialsOf(secrets);

    const expected = creds.appSecret ? await hmacSha256Hex(creds.appSecret, raw) : "";
    if (!expected || !safeEqual(signature, expected)) {
      rejected = true;
      // Подсказка нужна при настройке. На рабочем канале поддельный запрос не должен затирать статус.
      if (!channel.last_event_at) {
        await recordChannelError(db, channel.id, "Подпись webhook не совпала: проверьте App Secret в настройках канала.");
      }
      continue;
    }

    for (const { event } of items) await processEvent(db, channel, creds, event);
  }

  return rejected ? new Response("invalid signature", { status: 401 }) : ok();
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const target = segments[segments.indexOf("webhook") + 1];
  if (!target) return new Response("not found", { status: 404 });

  try {
    const db = serviceClient();
    if (target === "meta") {
      if (req.method === "GET") return await handleMetaVerification(url, db);
      if (req.method === "POST") return await handleMetaEvents(req, db);
      return new Response("method not allowed", { status: 405 });
    }
    return await handleChannel(req, db, target);
  } catch (error) {
    // 500 заставит платформу повторить доставку. Дубликаты отсекаются по id сообщения.
    console.error("Ошибка обработки webhook", error);
    return new Response("error", { status: 500 });
  }
});
