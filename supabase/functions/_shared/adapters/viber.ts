import { type Adapter, ChannelError, type InboundEvent } from "../types.ts";
import { fitOptions, splitText } from "../text.ts";

const API = "https://chatapi.viber.com/pa";

// deno-lint-ignore no-explicit-any
type Json = any;

async function call(token: string, path: string, body: Record<string, unknown> = {}): Promise<Json> {
  const res = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Viber-Auth-Token": token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => null);
  if (data?.status === 0) return data;
  const status = data?.status;
  if (status === 2) throw new ChannelError("Viber не принял токен. Скопируйте его заново в панели администратора бота.");
  if (status === 6) throw new ChannelError("Клиент не подписан на бота, Viber не даёт ему написать.", 502);
  if (status === 23 || status === 24) throw new ChannelError("Закончился бесплатный лимит или баланс Viber.", 502);
  throw new ChannelError(`Viber: ${data?.status_message ?? `HTTP ${res.status}`}`, 502);
}

const ATTACHMENTS: Record<string, string> = {
  picture: "Фото",
  video: "Видео",
  file: "Файл",
  sticker: "Стикер",
  location: "Геолокация",
  contact: "Контакт",
  url: "Ссылка",
};

export function parseViber(body: Json): InboundEvent[] {
  if (body?.event !== "message" || !body.sender?.id || !body.message) return [];
  const message = body.message;
  const text: string | undefined = message.text ?? message.contact?.phone_number;
  return [{
    kind: "message",
    externalUserId: String(body.sender.id),
    messageId: String(body.message_token),
    text,
    attachment: text ? undefined : (ATTACHMENTS[message.type] ?? "Вложение"),
    displayName: body.sender.name,
  }];
}

export const viber: Adapter = {
  async identify(creds) {
    const info = await call(creds.token, "get_account_info");
    return { externalId: String(info.id), name: info.name ?? "Viber", username: info.uri };
  },
  async activate({ creds, webhookUrl }) {
    await call(creds.token, "set_webhook", {
      url: webhookUrl,
      event_types: ["message", "subscribed", "unsubscribed", "conversation_started"],
      send_name: true,
      send_photo: false,
    });
  },
  async deactivate(creds) {
    await call(creds.token, "set_webhook", { url: "" });
  },
  async send({ creds, channelName, contact }, message) {
    const fitted = fitOptions(message, { maxLabel: 250, maxButtons: 24 });
    const chunks = splitText(fitted.text, { chars: 7000 });
    let lastId: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const withKeyboard = i === chunks.length - 1 && fitted.buttons.length > 0;
      const data = await call(creds.token, "send_message", {
        receiver: contact.externalId,
        type: "text",
        text: chunks[i],
        sender: { name: channelName.slice(0, 28) },
        min_api_version: 3,
        ...(withKeyboard
          ? {
            keyboard: {
              Type: "keyboard",
              DefaultHeight: false,
              // Кнопка отправляет текст варианта обычным сообщением, бот сопоставит его с ответом.
              Buttons: fitted.buttons.map((b) => ({
                Columns: 6,
                Rows: 1,
                ActionType: "reply",
                ActionBody: b.label,
                Text: b.label,
              })),
            },
          }
          : {}),
      });
      lastId = data.message_token === undefined ? undefined : String(data.message_token);
    }
    return lastId;
  },
};
