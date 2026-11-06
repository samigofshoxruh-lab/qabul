import { type Adapter, ChannelError, type Credentials, type InboundEvent } from "../types.ts";
import { optionPayload, parseOptionPayload, splitText } from "../text.ts";

const API = "https://api.telegram.org";

// Обычный бот и бот, подключённый к личному аккаунту через Telegram Business, получают разные типы обновлений.
export const ALLOWED_UPDATES = ["message", "callback_query", "business_connection", "business_message"];

// deno-lint-ignore no-explicit-any
type Json = any;

async function call(token: string, method: string, params: Record<string, unknown> = {}): Promise<Json> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => null);
  if (data?.ok) return data.result;

  const description: string = data?.description ?? `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 404) {
    throw new ChannelError("Telegram не принял токен. Скопируйте его заново у @BotFather.");
  }
  if (res.status === 403) throw new ChannelError("Клиент заблокировал бота, сообщение не доставлено.", 502);
  throw new ChannelError(`Telegram: ${description}`, 502);
}

function attachmentOf(m: Json): string | undefined {
  if (m.photo) return "Фото";
  if (m.video) return "Видео";
  if (m.video_note) return "Видеосообщение";
  if (m.voice) return "Голосовое сообщение";
  if (m.audio) return "Аудио";
  if (m.document) return "Файл";
  if (m.sticker) return "Стикер";
  if (m.location) return "Геолокация";
  return undefined;
}

function fullName(user: Json): string | undefined {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ");
  return name || undefined;
}

export function parseTelegram(update: Json): InboundEvent[] {
  const callback = update?.callback_query;
  if (callback) {
    const chatId = callback.message?.chat?.id ?? callback.from?.id;
    if (chatId === undefined || (callback.message?.chat?.type && callback.message.chat.type !== "private")) return [];
    const businessId: string | null = callback.message?.business_connection_id ?? null;
    const messageId = callback.message?.message_id;
    return [{
      kind: "message",
      externalUserId: String(chatId),
      messageId: `cb:${callback.id}`,
      optionId: parseOptionPayload(callback.data) ?? "stale",
      displayName: fullName(callback.from),
      username: callback.from?.username,
      contactMeta: { bc: businessId },
      // Снимаем «часики» с кнопки и убираем клавиатуру, чтобы вариант нельзя было нажать повторно.
      ack: async (creds: Credentials) => {
        await call(creds.token, "answerCallbackQuery", { callback_query_id: callback.id }).catch(() => {});
        if (messageId !== undefined) {
          await call(creds.token, "editMessageReplyMarkup", {
            chat_id: chatId,
            message_id: messageId,
            ...(businessId ? { business_connection_id: businessId } : {}),
          }).catch(() => {});
        }
      },
    }];
  }

  const isBusiness = Boolean(update?.business_message);
  const message = update?.business_message ?? update?.message;
  if (!message || message.chat?.type !== "private" || !message.from) return [];

  const chatId = String(message.chat.id);
  const messageId = `${chatId}:${message.message_id}`;
  const text: string | undefined = message.text ?? message.caption ?? message.contact?.phone_number;

  if (isBusiness && String(message.from.id) !== chatId) {
    // Исходящее из бизнес-аккаунта: своё сообщение бота пропускаем, ответ человека фиксируем.
    if (message.sender_business_bot) return [];
    return [{ kind: "owner_message", externalUserId: chatId, messageId, text }];
  }
  if (message.from.is_bot) return [];

  return [{
    kind: "message",
    externalUserId: chatId,
    messageId,
    text,
    attachment: text ? undefined : attachmentOf(message),
    displayName: fullName(message.from),
    username: message.from.username,
    contactMeta: { bc: message.business_connection_id ?? null },
  }];
}

export const telegram: Adapter = {
  async identify(creds) {
    const me = await call(creds.token, "getMe");
    return { externalId: String(me.id), name: me.first_name ?? me.username, username: me.username };
  },

  async activate({ creds, webhookUrl, secret }) {
    await call(creds.token, "setWebhook", {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ALLOWED_UPDATES,
    });
  },

  async deactivate(creds) {
    await call(creds.token, "deleteWebhook");
  },

  async send({ creds, contact }, message) {
    const businessId = contact.meta?.bc as string | null | undefined;
    const chunks = splitText(message.text, { chars: 4096 });
    let lastId: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const sent = await call(creds.token, "sendMessage", {
        chat_id: contact.externalId,
        text: chunks[i],
        ...(businessId ? { business_connection_id: businessId } : {}),
        // Обычная клавиатура в Telegram Business не работает, поэтому всегда inline-кнопки.
        ...(isLast && message.options?.length
          ? {
            reply_markup: {
              inline_keyboard: message.options.map((o) => [{ text: o.label, callback_data: optionPayload(o.id) }]),
            },
          }
          : {}),
      });
      lastId = `${contact.externalId}:${sent.message_id}`;
    }
    return lastId;
  },
};
