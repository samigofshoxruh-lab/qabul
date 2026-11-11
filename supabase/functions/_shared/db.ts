import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { decrypt } from "./crypto.ts";
import { type Adapter, ChannelError, type ContactRef, type Credentials, type OutMessage, type Platform } from "./types.ts";

function secretKey(): string {
  // На новых проектах ключи лежат в SUPABASE_SECRET_KEYS, на старых в SUPABASE_SERVICE_ROLE_KEY.
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const parsed = JSON.parse(keys);
      if (parsed.default) return parsed.default;
    } catch {
      console.warn("SUPABASE_SECRET_KEYS не удалось разобрать");
    }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("Не найден секретный ключ Supabase");
  return legacy;
}

export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export interface ChannelRow {
  id: string;
  workspace_id: string;
  platform: Platform;
  name: string;
  external_id: string;
  is_active: boolean;
  last_event_at: string | null;
}

export interface SecretsRow {
  channel_id: string;
  token_enc: string;
  app_secret_enc: string | null;
  webhook_secret: string;
  extra: Record<string, unknown>;
}

export async function loadSecrets(db: SupabaseClient, channelId: string): Promise<SecretsRow | null> {
  const { data, error } = await db.from("channel_secrets").select("*").eq("channel_id", channelId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function credentialsOf(secrets: SecretsRow): Promise<Credentials> {
  return {
    token: await decrypt(secrets.token_enc),
    appSecret: secrets.app_secret_enc ? await decrypt(secrets.app_secret_enc) : undefined,
    phoneNumberId: secrets.extra?.phone_number_id as string | undefined,
    wabaId: secrets.extra?.waba_id as string | undefined,
    accountId: secrets.extra?.account_id as string | undefined,
  };
}

export async function recordChannelError(db: SupabaseClient, channelId: string, message: string) {
  const { error } = await db.from("channels").update({
    last_error: message.slice(0, 500),
    last_error_at: new Date().toISOString(),
  }).eq("id", channelId);
  if (error) console.error("Не удалось записать ошибку канала", error);
}

/** Отправляет подготовленные сообщения по порядку и фиксирует результат каждого. */
export async function deliver(
  db: SupabaseClient,
  adapter: Adapter,
  context: { creds: Credentials; channelName: string; contact: ContactRef },
  outbound: (OutMessage & { id: string })[],
) {
  for (const message of outbound) {
    try {
      const externalId = await adapter.send(context, message);
      await db.rpc("bot_message_result", { p_message_id: message.id, p_external_id: externalId ?? null, p_error: null });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      console.error("Не удалось отправить сообщение", text);
      await db.rpc("bot_message_result", {
        p_message_id: message.id,
        p_external_id: null,
        p_error: text,
        // Ошибки со статусом 400 означают проблему токена или настроек, а не конкретного клиента.
        p_channel_error: error instanceof ChannelError && error.status === 400,
      });
    }
  }
}
