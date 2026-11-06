import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;

export const isConfigured = Boolean(url && key);
export const supabase: SupabaseClient = isConfigured ? createClient(url!, key!) : (null as unknown as SupabaseClient);

/** Вызывает Edge Function и превращает ошибку сервера в обычный Error с понятным текстом. */
export async function callFunction<T = Record<string, unknown>>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let message = "Сервер не ответил. Проверьте, что Edge Functions задеплоены.";
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === "function") {
      const payload = await context.json().catch(() => null);
      if (payload?.error) message = payload.error;
      else if (payload?.message) message = payload.message;
    }
    throw new Error(message);
  }
  return data as T;
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error));
