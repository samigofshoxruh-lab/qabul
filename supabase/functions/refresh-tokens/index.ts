// Раз в час из pg_cron: продлевает токены Instagram (они живут 60 дней) и проверяет,
// что токены всех каналов ещё работают, чтобы владелец узнал о поломке раньше клиентов.
import { adapters } from "../_shared/adapters/index.ts";
import { refreshInstagramToken } from "../_shared/adapters/meta.ts";
import { encrypt, safeEqual } from "../_shared/crypto.ts";
import { credentialsOf, loadSecrets, recordChannelError, serviceClient } from "../_shared/db.ts";
import { json } from "../_shared/http.ts";
import { ChannelError, type Platform } from "../_shared/types.ts";

const REFRESH_BEFORE_DAYS = 20;
const REFRESH_ERROR = "Не удалось продлить токен: ";
const CHECK_ERROR = "Проверка токена не прошла: ";
const CHECK_BATCH = 5;

interface ChannelRow {
  id: string;
  platform: Platform;
  is_active: boolean;
  last_error: string | null;
  token_expires_at: string | null;
}

Deno.serve(async (req) => {
  const expected = Deno.env.get("CRON_SECRET");
  const given = req.headers.get("x-cron-secret") ?? "";
  if (!expected || !safeEqual(given, expected)) return json({ error: "forbidden" }, 401);

  const db = serviceClient();
  const { data, error } = await db.from("channels")
    .select("id, platform, is_active, last_error, token_expires_at")
    .is("deleted_at", null);
  if (error) return json({ error: error.message }, 500);
  const channels = (data ?? []) as ChannelRow[];

  // Снимаем только свою отметку: ошибку отправки клиенту снимет следующая удачная отправка.
  const clearError = async (channel: ChannelRow, prefix: string) => {
    if (!channel.last_error?.startsWith(prefix)) return;
    await db.from("channels").update({ last_error: null, last_error_at: null }).eq("id", channel.id);
    channel.last_error = null;
  };

  // Токены продлеваем и у выключенных каналов, и у компаний с истёкшим сроком: иначе после продления всё сломается.
  const threshold = Date.now() + REFRESH_BEFORE_DAYS * 24 * 3600 * 1000;
  const refreshed = [];
  for (const channel of channels) {
    if (channel.platform !== "instagram" || !channel.token_expires_at || new Date(channel.token_expires_at).getTime() >= threshold) continue;
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
      await clearError(channel, REFRESH_ERROR);
      refreshed.push({ id: channel.id, ok: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await recordChannelError(db, channel.id, REFRESH_ERROR + message);
      channel.last_error = REFRESH_ERROR + message;
      refreshed.push({ id: channel.id, ok: false });
    }
  }

  // Сбой сети или самой соцсети поломкой не считаем: тревогу поднимает только отказ в токене.
  const active = channels.filter((c) => c.is_active);
  let broken = 0;
  for (let i = 0; i < active.length; i += CHECK_BATCH) {
    await Promise.all(active.slice(i, i + CHECK_BATCH).map(async (channel) => {
      try {
        const secrets = await loadSecrets(db, channel.id);
        if (!secrets) return;
        await adapters[channel.platform].identify(await credentialsOf(secrets));
        await clearError(channel, CHECK_ERROR);
      } catch (e) {
        if (e instanceof ChannelError && e.status === 400) {
          broken++;
          await recordChannelError(db, channel.id, CHECK_ERROR + e.message);
        } else {
          console.warn("Не удалось проверить канал", channel.id, e instanceof Error ? e.message : e);
        }
      }
    }));
  }

  return json({ refreshed, checked: active.length, broken });
});
