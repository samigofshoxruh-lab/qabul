// Напоминания ученикам об уроке. Запускается каждые 5 минут из pg_cron.
import { adapters } from "../_shared/adapters/index.ts";
import { safeEqual } from "../_shared/crypto.ts";
import { credentialsOf, deliver, loadSecrets, serviceClient } from "../_shared/db.ts";
import { json } from "../_shared/http.ts";
import type { Platform } from "../_shared/types.ts";

interface Due {
  message_id: string;
  text: string;
  channel_id: string;
  platform: Platform;
  channel_name: string;
  external_id: string;
  meta: Record<string, unknown>;
}

Deno.serve(async (req) => {
  const expected = Deno.env.get("CRON_SECRET");
  const given = req.headers.get("x-cron-secret") ?? "";
  if (!expected || !safeEqual(given, expected)) return json({ error: "forbidden" }, 401);

  const db = serviceClient();
  const { data, error } = await db.rpc("lesson_reminders_claim");
  if (error) return json({ error: error.message }, 500);

  const due = (data ?? []) as Due[];
  const byChannel = new Map<string, Due[]>();
  for (const item of due) byChannel.set(item.channel_id, [...(byChannel.get(item.channel_id) ?? []), item]);

  await Promise.all([...byChannel.values()].map(async (items) => {
    const { channel_id: channelId, platform, channel_name: channelName } = items[0];
    try {
      const secrets = await loadSecrets(db, channelId);
      if (!secrets) throw new Error("Канал отключён");
      const creds = await credentialsOf(secrets);
      for (const item of items) {
        await deliver(db, adapters[platform], {
          creds,
          channelName,
          contact: { externalId: item.external_id, meta: item.meta },
        }, [{ id: item.message_id, text: item.text }]);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      for (const item of items) {
        await db.rpc("bot_message_result", { p_message_id: item.message_id, p_external_id: null, p_error: message });
      }
    }
  }));

  return json({ sent: due.length });
});
