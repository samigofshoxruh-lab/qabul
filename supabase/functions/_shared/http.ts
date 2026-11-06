import type { SupabaseClient, User } from "npm:@supabase/supabase-js@2.119.0";
import { ChannelError } from "./types.ts";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8" },
  });
}

export async function requireUser(req: Request, db: SupabaseClient): Promise<User> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new ChannelError("Войдите в аккаунт", 401);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new ChannelError("Сессия истекла, войдите снова", 401);
  return data.user;
}

export async function requireOwner(db: SupabaseClient, userId: string, workspaceId: unknown) {
  if (typeof workspaceId !== "string") throw new ChannelError("Не указан кабинет");
  const { data: role, error } = await db.rpc("service_member_role", { p_workspace: workspaceId, p_user: userId });
  if (error) throw error;
  if (role !== "owner") throw new ChannelError("Это действие доступно только владельцу с действующим доступом", 403);
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ChannelError) return json({ error: error.message }, error.status);
  console.error(error);
  return json({ error: "Внутренняя ошибка. Подробности в логах функции." }, 500);
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object") return body;
  } catch {
    // Ниже вернём понятную ошибку.
  }
  throw new ChannelError("Некорректный запрос");
}
