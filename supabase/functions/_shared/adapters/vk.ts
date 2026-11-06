import { type Adapter, ChannelError, type InboundEvent } from "../types.ts";
import { fitOptions, splitText } from "../text.ts";

const API = "https://api.vk.com/method";
const VERSION = "5.199";

// deno-lint-ignore no-explicit-any
type Json = any;

async function call(token: string, method: string, params: Record<string, string | number> = {}): Promise<Json> {
  const body = new URLSearchParams({ access_token: token, v: VERSION });
  for (const [key, value] of Object.entries(params)) body.set(key, String(value));
  const res = await fetch(`${API}/${method}`, { method: "POST", body, signal: AbortSignal.timeout(15_000) });
  const data = await res.json().catch(() => null);
  if (data?.error) {
    const code = data.error.error_code;
    if (code === 5) throw new ChannelError("VK не принял токен. Создайте ключ сообщества заново.");
    if (code === 15 || code === 27) {
      throw new ChannelError("Токену VK не хватает прав. Нужен ключ сообщества с правами «Управление сообществом» и «Сообщения».");
    }
    if (code === 901) throw new ChannelError("Клиент запретил сообщения от сообщества.", 502);
    throw new ChannelError(`VK: ${data.error.error_msg}`, 502);
  }
  if (!data) throw new ChannelError(`VK: HTTP ${res.status}`, 502);
  return data.response;
}

export function parseVk(body: Json): InboundEvent[] {
  if (body?.type !== "message_new") return [];
  const message = body.object?.message;
  // Беседы и сообщения от других сообществ опрос не проходят.
  if (!message || message.from_id <= 0 || message.peer_id >= 2_000_000_000) return [];

  let optionId: string | undefined;
  if (message.payload) {
    try {
      optionId = JSON.parse(message.payload)?.o;
    } catch {
      optionId = undefined;
    }
  }
  const text: string | undefined = message.text || undefined;
  return [{
    kind: "message",
    externalUserId: String(message.from_id),
    messageId: `${message.peer_id}:${message.id || message.conversation_message_id}`,
    text,
    optionId,
    attachment: !text && message.attachments?.length ? "Вложение" : undefined,
  }];
}

export const vk: Adapter = {
  async identify(creds) {
    const response = await call(creds.token, "groups.getById");
    const group = response?.groups?.[0] ?? response?.[0];
    if (!group?.id) throw new ChannelError("Это не ключ сообщества VK. Создайте его в разделе «Работа с API».");
    return { externalId: String(group.id), name: group.name ?? "VK", username: group.screen_name };
  },

  async activate({ creds, identity, webhookUrl, secret, saveExtra }) {
    const groupId = identity.externalId;
    // VK проверяет адрес сразу при добавлении сервера, поэтому код подтверждения сохраняем заранее.
    const { code } = await call(creds.token, "groups.getCallbackConfirmationCode", { group_id: groupId });
    await saveExtra({ vk_confirmation: code });

    const servers = await call(creds.token, "groups.getCallbackServers", { group_id: groupId });
    let serverId = servers?.items?.find((s: Json) => s.url === webhookUrl)?.id;
    if (!serverId) {
      const added = await call(creds.token, "groups.addCallbackServer", {
        group_id: groupId,
        url: webhookUrl,
        title: "CRM",
        secret_key: secret.slice(0, 50),
      });
      serverId = added.server_id;
    }
    await call(creds.token, "groups.setCallbackSettings", {
      group_id: groupId,
      server_id: serverId,
      api_version: VERSION,
      message_new: 1,
    });
  },

  async deactivate() {
    // Отключить сервер можно в настройках сообщества. Удалённый канал просто перестаёт обрабатывать события.
  },

  async send({ creds, contact }, message) {
    const fitted = fitOptions(message, { maxLabel: 40, maxButtons: 10 });
    const chunks = splitText(fitted.text, { chars: 4000 });
    let lastId: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const withKeyboard = i === chunks.length - 1;
      const keyboard = {
        one_time: true,
        buttons: fitted.buttons.map((b) => [{
          action: { type: "text", label: b.label, payload: JSON.stringify({ o: b.id }) },
          color: "secondary",
        }]),
      };
      const id = await call(creds.token, "messages.send", {
        peer_id: contact.externalId,
        message: chunks[i],
        random_id: crypto.getRandomValues(new Int32Array(1))[0],
        ...(withKeyboard ? { keyboard: JSON.stringify(keyboard) } : {}),
      });
      lastId = `${contact.externalId}:${id}`;
    }
    return lastId;
  },

  async fetchProfile(creds, id) {
    const users = await call(creds.token, "users.get", { user_ids: id, fields: "screen_name" });
    const user = users?.[0];
    if (!user) return null;
    return { displayName: [user.first_name, user.last_name].filter(Boolean).join(" "), username: user.screen_name };
  },
};
