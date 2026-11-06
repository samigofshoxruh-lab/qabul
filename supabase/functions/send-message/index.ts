// Ответ администратора клиенту с сайта.
import { adapters } from "../_shared/adapters/index.ts";
import { credentialsOf, deliver, loadSecrets, serviceClient } from "../_shared/db.ts";
import { cors, errorResponse, json, readJson, requireUser } from "../_shared/http.ts";
import { ChannelError } from "../_shared/types.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const db = serviceClient();
    const user = await requireUser(req, db);
    const body = await readJson(req);

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw new ChannelError("Напишите текст сообщения");
    if (text.length > 4000) throw new ChannelError("Сообщение длиннее 4000 символов");
    if (typeof body.lead_id !== "string") throw new ChannelError("Не указана заявка");

    const { data: queued, error } = await db.rpc("agent_queue_message", {
      p_lead_id: body.lead_id,
      p_agent_id: user.id,
      p_text: text,
    });
    if (error) {
      if (error.code === "42501") throw new ChannelError("Заявка не найдена", 404);
      throw error;
    }

    const { data: channel, error: channelError } = await db.from("channels").select("*").eq("id", queued.channel_id).single();
    if (channelError) throw channelError;
    const secrets = await loadSecrets(db, channel.id);
    if (!secrets || channel.deleted_at) {
      await db.rpc("bot_message_result", { p_message_id: queued.message_id, p_error: "Канал отключён" });
      throw new ChannelError("Канал отключён. Подключите его заново, чтобы отвечать клиенту.");
    }

    await deliver(db, adapters[channel.platform as keyof typeof adapters], {
      creds: await credentialsOf(secrets),
      channelName: channel.name,
      contact: { externalId: queued.contact_external_id, meta: queued.contact_meta },
    }, [{ id: queued.message_id, text }]);

    const { data: message } = await db.from("messages").select("status, error").eq("id", queued.message_id).single();
    if (message?.status === "failed") return json({ error: message.error }, 502);
    return json({ ok: true, message_id: queued.message_id });
  } catch (error) {
    return errorResponse(error);
  }
});
