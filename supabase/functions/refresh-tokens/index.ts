// Продлевает токены Instagram: они живут 60 дней. Запускается раз в день из pg_cron.
import { refreshInstagramToken } from "../_shared/adapters/meta.ts";
import { encrypt, safeEqual } from "../_shared/crypto.ts";
import { credentialsOf, loadSecrets, serviceClient } from "../_shared/db.ts";
import { json } from "../_shared/http.ts";

const REFRESH_BEFORE_DAYS = 20;

Deno.serve(async (req) => {
  const expected = Deno.env.get("CRON_SECRET");
  const given = req.headers.get("x-cron-secret") ?? "";
  if (!expected || !safeEqual(given, expected)) return json({ error: "forbidden" }, 401);

  const db = serviceClient();
  const threshold = new Date(Date.now() + REFRESH_BEFORE_DAYS * 24 * 3600 * 1000).toISOString();
  const { data: channels, error } = await db.from("channels").select("id, name")
    .eq("platform", "instagram").is("deleted_at", null).lt("token_expires_at", threshold);
  if (error) return json({ error: error.message }, 500);

  const results = [];
  for (const channel of channels ?? []) {
    try {
      const secrets = await loadSecrets(db, channel.id);
      if (!secrets) continue;
      const { token } = await credentialsOf(secrets);
      const fresh = await refreshInstagramToken(token);
      await db.from("channel_secrets").update({
        token_enc: await encrypt(fresh.token),
        updated_at: new Date().toISOString(),
      }).eq("channel_id", channel.id);
      await db.from("channels").update({
        token_expires_at: fresh.expiresAt,
        token_hint: `••••${fresh.token.slice(-4)}`,
      }).eq("id", channel.id);
      results.push({ id: channel.id, ok: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await db.from("channels").update({
        last_error: `Не удалось продлить токен: ${message}`.slice(0, 500),
        last_error_at: new Date().toISOString(),
      }).eq("id", channel.id);
      results.push({ id: channel.id, ok: false });
    }
  }
  return json({ refreshed: results });
});
