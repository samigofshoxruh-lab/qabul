// Instagram, Facebook Messenger и WhatsApp Cloud API: у них общий формат webhook и подпись X-Hub-Signature-256.
import { type Adapter, ChannelError, type Credentials, type InboundEvent, type Platform } from "../types.ts";
import { fitOptions, optionPayload, parseOptionPayload, splitText } from "../text.ts";

const VERSION = Deno.env.get("GRAPH_API_VERSION") ?? "v25.0";
const INSTAGRAM = `https://graph.instagram.com/${VERSION}`;
const FACEBOOK = `https://graph.facebook.com/${VERSION}`;

// deno-lint-ignore no-explicit-any
type Json = any;

function metaError(error: Json, status: number): ChannelError {
  const code = error?.code;
  const subcode = error?.error_subcode;
  if (code === 190) return new ChannelError("Токен недействителен или истёк. Выпустите новый и подключите канал заново.");
  if (code === 10 && [2534022, 2018278].includes(subcode)) {
    return new ChannelError("Клиент писал больше 24 часов назад. Платформа не даёт ответить через API, напишите ему в приложении.", 502);
  }
  if (code === 10 && subcode === 2534041) {
    return new ChannelError("В настройках Instagram выключен доступ к сообщениям: Настройки → Сообщения → «Разрешить доступ к сообщениям».");
  }
  if (code === 131047) {
    return new ChannelError("Клиент писал больше 24 часов назад. WhatsApp разрешает написать ему только шаблоном.", 502);
  }
  if (code === 3 || code === 10 || code === 200) {
    return new ChannelError(`У приложения Meta нет нужного разрешения: ${error?.message ?? "нет доступа"}`, 502);
  }
  return new ChannelError(`Meta: ${error?.message ?? `HTTP ${status}`}`, 502);
}

async function call(url: string, token: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<Json> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(init.query ?? {})) target.searchParams.set(key, value);
  target.searchParams.set("access_token", token);
  const res = await fetch(target, {
    method: init.method ?? "GET",
    headers: init.body ? { "content-type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) throw metaError(data?.error, res.status);
  return data;
}

function attachmentLabel(type: unknown): string {
  const labels: Record<string, string> = {
    image: "Фото",
    video: "Видео",
    audio: "Голосовое сообщение",
    file: "Файл",
    story_mention: "Упоминание в истории",
    ig_reel: "Reels",
    share: "Репост",
  };
  return labels[String(type)] ?? "Вложение";
}

export interface MetaRoutedEvent {
  platform: Platform;
  routeId: string;
  event: InboundEvent;
}

export function parseMeta(body: Json): MetaRoutedEvent[] {
  const events: MetaRoutedEvent[] = [];
  const entries: Json[] = Array.isArray(body?.entry) ? body.entry : [];

  if (body?.object === "instagram" || body?.object === "page") {
    const platform: Platform = body.object === "instagram" ? "instagram" : "facebook";
    for (const entry of entries) {
      for (const item of entry?.messaging ?? []) {
        const senderId = item?.sender?.id;
        if (!senderId || String(senderId) === String(entry.id)) continue;

        if (item.postback) {
          events.push({
            platform,
            routeId: String(entry.id),
            event: {
              kind: "message",
              externalUserId: String(senderId),
              messageId: String(item.postback.mid ?? `pb:${senderId}:${item.timestamp}`),
              text: item.postback.title,
              optionId: parseOptionPayload(item.postback.payload),
            },
          });
          continue;
        }

        const message = item.message;
        // Эхо своих же сообщений обязательно пропускаем, иначе бот начнёт отвечать сам себе.
        if (!message || message.is_echo || message.is_deleted || message.is_unsupported) continue;

        const attachment = message.attachments?.[0];
        events.push({
          platform,
          routeId: String(entry.id),
          event: {
            kind: "message",
            externalUserId: String(senderId),
            messageId: String(message.mid),
            text: message.text,
            optionId: parseOptionPayload(message.quick_reply?.payload),
            attachment: !message.text && attachment ? attachmentLabel(attachment.type) : undefined,
          },
        });
      }
    }
    return events;
  }

  if (body?.object === "whatsapp_business_account") {
    for (const entry of entries) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        const routeId = value?.metadata?.phone_number_id;
        if (!routeId) continue;
        for (const message of value?.messages ?? []) {
          const contact = (value.contacts ?? []).find((c: Json) => c.wa_id === message.from) ?? value.contacts?.[0];
          const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
          const payload = reply?.id ?? message.button?.payload;
          const text: string | undefined = message.text?.body ?? reply?.title ?? message.button?.text ?? message.image?.caption;
          events.push({
            platform: "whatsapp",
            routeId: String(routeId),
            event: {
              kind: "message",
              externalUserId: String(message.from),
              messageId: String(message.id),
              text,
              optionId: parseOptionPayload(payload),
              attachment: text ? undefined : attachmentLabel(message.type),
              displayName: contact?.profile?.name,
            },
          });
        }
      }
    }
  }
  return events;
}

const MESSAGING_FIELDS = "messages,messaging_postbacks";

function quickReplies(buttons: { id: string; label: string }[]) {
  return buttons.length
    ? { quick_replies: buttons.map((b) => ({ content_type: "text", title: b.label, payload: optionPayload(b.id) })) }
    : {};
}

async function sendPageStyle(baseUrl: string, creds: Credentials, recipient: string, message: Parameters<Adapter["send"]>[1], limit: { chars?: number; bytes?: number }) {
  const fitted = fitOptions(message, { maxLabel: 20, maxButtons: 13 });
  const chunks = splitText(fitted.text, limit);
  let lastId: string | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const data = await call(`${baseUrl}/me/messages`, creds.token, {
      method: "POST",
      body: {
        recipient: { id: recipient },
        messaging_type: "RESPONSE",
        message: { text: chunks[i], ...(i === chunks.length - 1 ? quickReplies(fitted.buttons) : {}) },
      },
    });
    lastId = data.message_id;
  }
  return lastId;
}

export const instagram: Adapter = {
  async identify(creds) {
    const me = await call(`${INSTAGRAM}/me`, creds.token, { query: { fields: "user_id,username,name" } });
    return {
      // Именно user_id приходит в webhook как entry.id.
      externalId: String(me.user_id ?? me.id),
      name: me.username ? `@${me.username}` : (me.name ?? "Instagram"),
      username: me.username,
      // Долгоживущий токен Instagram действует 60 дней.
      tokenExpiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString(),
    };
  },
  async activate({ creds }) {
    await call(`${INSTAGRAM}/me/subscribed_apps`, creds.token, {
      method: "POST",
      query: { subscribed_fields: MESSAGING_FIELDS },
    });
  },
  async deactivate(creds) {
    await call(`${INSTAGRAM}/me/subscribed_apps`, creds.token, { method: "DELETE" });
  },
  send({ creds, contact }, message) {
    return sendPageStyle(INSTAGRAM, creds, contact.externalId, message, { bytes: 1000 });
  },
  async fetchProfile(creds, id) {
    const p = await call(`${INSTAGRAM}/${id}`, creds.token, { query: { fields: "name,username" } });
    return { displayName: p.name ?? p.username, username: p.username };
  },
};

export async function refreshInstagramToken(token: string): Promise<{ token: string; expiresAt: string }> {
  const data = await call("https://graph.instagram.com/refresh_access_token", token, {
    query: { grant_type: "ig_refresh_token" },
  });
  return {
    token: data.access_token,
    expiresAt: new Date(Date.now() + Number(data.expires_in ?? 60 * 24 * 3600) * 1000).toISOString(),
  };
}

export const facebook: Adapter = {
  async identify(creds) {
    const me = await call(`${FACEBOOK}/me`, creds.token, { query: { fields: "id,name" } });
    return { externalId: String(me.id), name: me.name ?? "Facebook" };
  },
  async activate({ creds }) {
    await call(`${FACEBOOK}/me/subscribed_apps`, creds.token, {
      method: "POST",
      query: { subscribed_fields: MESSAGING_FIELDS },
    });
  },
  async deactivate(creds) {
    await call(`${FACEBOOK}/me/subscribed_apps`, creds.token, { method: "DELETE" });
  },
  send({ creds, contact }, message) {
    return sendPageStyle(FACEBOOK, creds, contact.externalId, message, { chars: 2000 });
  },
  async fetchProfile(creds, id) {
    const p = await call(`${FACEBOOK}/${id}`, creds.token, { query: { fields: "name" } });
    return { displayName: p.name };
  },
};

export const whatsapp: Adapter = {
  async identify(creds) {
    if (!creds.phoneNumberId) throw new ChannelError("Укажите Phone number ID.");
    const me = await call(`${FACEBOOK}/${creds.phoneNumberId}`, creds.token, {
      query: { fields: "display_phone_number,verified_name" },
    });
    return {
      externalId: String(creds.phoneNumberId),
      name: me.verified_name ?? me.display_phone_number ?? "WhatsApp",
      username: me.display_phone_number,
    };
  },
  async activate({ creds }) {
    if (!creds.wabaId) throw new ChannelError("Укажите WhatsApp Business Account ID.");
    await call(`${FACEBOOK}/${creds.wabaId}/subscribed_apps`, creds.token, { method: "POST" });
  },
  async deactivate(creds) {
    if (creds.wabaId) await call(`${FACEBOOK}/${creds.wabaId}/subscribed_apps`, creds.token, { method: "DELETE" });
  },
  async send({ creds, contact }, message) {
    const url = `${FACEBOOK}/${creds.phoneNumberId}/messages`;
    const base = { messaging_product: "whatsapp", recipient_type: "individual", to: contact.externalId };
    const fitted = fitOptions(message, { maxLabel: 24, maxButtons: 10 });
    const buttons = fitted.buttons;
    const chunks = splitText(fitted.text, { chars: buttons.length ? 1024 : 4096 });
    let lastId: string | undefined;

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      let payload: Record<string, unknown>;
      if (isLast && buttons.length > 0 && buttons.length <= 3 && buttons.every((b) => b.label.length <= 20)) {
        payload = {
          ...base,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: chunks[i] },
            action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: optionPayload(b.id), title: b.label } })) },
          },
        };
      } else if (isLast && buttons.length > 0) {
        payload = {
          ...base,
          type: "interactive",
          interactive: {
            type: "list",
            body: { text: chunks[i] },
            action: {
              button: "Выбрать",
              sections: [{ rows: buttons.map((b) => ({ id: optionPayload(b.id), title: b.label })) }],
            },
          },
        };
      } else {
        payload = { ...base, type: "text", text: { body: chunks[i], preview_url: false } };
      }
      const data = await call(url, creds.token, { method: "POST", body: payload });
      lastId = data.messages?.[0]?.id;
    }
    return lastId;
  },
};
