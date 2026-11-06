// Консоль главного админа: компании, пользователи и сроки доступа.
// Всё здесь требует секретного ключа, поэтому работает только на сервере и только для главного админа.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { adapters } from "../_shared/adapters/index.ts";
import { credentialsOf, loadSecrets, serviceClient } from "../_shared/db.ts";
import { cors, errorResponse, json, readJson, requireUser } from "../_shared/http.ts";
import { ChannelError, type Platform } from "../_shared/types.ts";

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function checkCredentials(email: string, password: string) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ChannelError("Проверьте email");
  if (password.length < 8) throw new ChannelError("Пароль должен быть не короче 8 символов");
}

function parseDate(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new ChannelError("Проверьте дату");
  return date.toISOString();
}

async function createUser(db: SupabaseClient, email: string, password: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) {
    if (/already|exists|registered/i.test(error.message)) {
      throw new ChannelError("Этот email уже зарегистрирован. Укажите другой.", 409);
    }
    throw new ChannelError(`Не удалось создать пользователя: ${error.message}`, 502);
  }
  return data.user.id;
}

/** Срок новой компании: число месяцев, конкретная дата или бессрочно. */
function initialAccess(body: Record<string, unknown>): string | null {
  if (body.unlimited === true) return null;
  if (body.until) return parseDate(body.until);
  const months = Number(body.months);
  if (!Number.isInteger(months) || months < 1 || months > 120) throw new ChannelError("Укажите срок доступа");
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return date.toISOString();
}

async function overview(db: SupabaseClient) {
  const { data, error } = await db.from("workspaces")
    .select("id, name, access_until, is_suspended, created_at, workspace_members(user_id, email, role, access_until, created_at), channels(platform, deleted_at), leads(count)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((company) => ({
    id: company.id,
    name: company.name,
    access_until: company.access_until,
    is_suspended: company.is_suspended,
    created_at: company.created_at,
    members: company.workspace_members,
    channels: company.channels.filter((c: { deleted_at: string | null }) => !c.deleted_at).map((c: { platform: string }) => c.platform),
    leads_count: company.leads[0]?.count ?? 0,
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const db = serviceClient();
    const user = await requireUser(req, db);

    const { data: admin, error: adminError } = await db.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle();
    if (adminError) throw adminError;
    if (!admin) throw new ChannelError("Это действие доступно только главному админу", 403);

    const body = await readJson(req);
    const workspaceId = body.workspace_id as string;

    switch (body.action) {
      case "overview":
        return json({ companies: await overview(db) });

      case "create_company": {
        const name = text(body.name);
        const email = text(body.email).toLowerCase();
        const password = typeof body.password === "string" ? body.password : "";
        if (!name) throw new ChannelError("Напишите название компании");
        checkCredentials(email, password);
        const until = initialAccess(body);

        const ownerId = await createUser(db, email, password);
        const { data, error } = await db.rpc("platform_create_company", {
          p_name: name,
          p_owner_id: ownerId,
          p_owner_email: email,
          p_access_until: until,
        });
        if (error) {
          // Не оставляем пользователя без компании, если создание сорвалось.
          await db.auth.admin.deleteUser(ownerId);
          throw error;
        }
        return json({ workspace_id: data });
      }

      case "rename": {
        const name = text(body.name);
        if (!name) throw new ChannelError("Напишите название компании");
        const { error } = await db.from("workspaces").update({ name }).eq("id", workspaceId);
        if (error) throw error;
        return json({ ok: true });
      }

      case "set_access": {
        let extended: unknown;
        if (body.add_months !== undefined) {
          const months = Number(body.add_months);
          if (!Number.isInteger(months) || months < 1 || months > 120) throw new ChannelError("Проверьте срок");
          const { data, error } = await db.rpc("platform_extend_access", { p_workspace: workspaceId, p_months: months });
          if (error) throw error;
          extended = data;
        } else {
          const until = body.unlimited === true ? null : parseDate(body.until);
          const { error } = await db.from("workspaces").update({ access_until: until }).eq("id", workspaceId);
          if (error) throw error;
        }

        // Владелец живёт по сроку компании: иначе его личный срок закрыл бы ему кабинет раньше.
        // Снимаем только после того, как новый срок компании записан.
        const { error: ownerError } = await db.from("workspace_members").update({ access_until: null })
          .eq("workspace_id", workspaceId).eq("role", "owner");
        if (ownerError) throw ownerError;

        return json(extended === undefined ? { ok: true } : { ok: true, access_until: extended });
      }

      case "set_suspended": {
        const { error } = await db.from("workspaces").update({ is_suspended: body.suspended === true }).eq("id", workspaceId);
        if (error) throw error;
        return json({ ok: true });
      }

      case "add_user": {
        const email = text(body.email).toLowerCase();
        const password = typeof body.password === "string" ? body.password : "";
        const role = body.role === "owner" ? "owner" : "admin";
        checkCredentials(email, password);
        const until = body.until ? parseDate(body.until) : null;

        const { data: company, error: companyError } = await db.from("workspaces").select("id").eq("id", workspaceId).maybeSingle();
        if (companyError) throw companyError;
        if (!company) throw new ChannelError("Компания не найдена", 404);

        const userId = await createUser(db, email, password);
        const { error } = await db.from("workspace_members").insert({
          workspace_id: workspaceId,
          user_id: userId,
          role,
          email,
          access_until: until,
        });
        if (error) {
          await db.auth.admin.deleteUser(userId);
          throw error;
        }
        return json({ user_id: userId });
      }

      case "set_user_access": {
        const until = body.until ? parseDate(body.until) : null;
        const { error } = await db.from("workspace_members").update({ access_until: until })
          .eq("workspace_id", workspaceId).eq("user_id", body.user_id as string);
        if (error) throw error;
        return json({ ok: true });
      }

      case "clear_user_terms": {
        const { error } = await db.from("workspace_members").update({ access_until: null }).eq("workspace_id", workspaceId);
        if (error) throw error;
        return json({ ok: true });
      }

      case "set_password": {
        const password = typeof body.password === "string" ? body.password : "";
        if (password.length < 8) throw new ChannelError("Пароль должен быть не короче 8 символов");
        const { error } = await db.auth.admin.updateUserById(body.user_id as string, { password });
        if (error) throw new ChannelError(`Не удалось сменить пароль: ${error.message}`, 502);
        return json({ ok: true });
      }

      case "remove_user": {
        const userId = body.user_id as string;
        const { data: members, error } = await db.from("workspace_members").select("user_id, role").eq("workspace_id", workspaceId);
        if (error) throw error;
        const member = members?.find((m) => m.user_id === userId);
        if (!member) throw new ChannelError("Пользователь не найден", 404);
        if (member.role === "owner" && members!.filter((m) => m.role === "owner").length === 1) {
          throw new ChannelError("Нельзя удалить единственного владельца компании");
        }
        const { error: deleteError } = await db.from("workspace_members").delete().eq("workspace_id", workspaceId).eq("user_id", userId);
        if (deleteError) throw deleteError;

        // Учётную запись удаляем, только если она больше нигде не нужна.
        const { count } = await db.from("workspace_members").select("*", { count: "exact", head: true }).eq("user_id", userId);
        const { data: isAdmin } = await db.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
        if (!count && !isAdmin) {
          const { error: authError } = await db.auth.admin.deleteUser(userId);
          if (authError) console.warn("Не удалось удалить учётную запись", authError.message);
        }
        return json({ ok: true });
      }

      case "delete_company": {
        const { data: company, error: companyError } = await db.from("workspaces").select("id, name").eq("id", workspaceId).maybeSingle();
        if (companyError) throw companyError;
        if (!company) throw new ChannelError("Компания не найдена", 404);
        if (body.confirm !== true) throw new ChannelError("Подтвердите удаление компании");

        const { data: members, error: membersError } = await db.from("workspace_members").select("user_id").eq("workspace_id", workspaceId);
        if (membersError) throw membersError;
        const { data: channels, error: channelsError } = await db.from("channels").select("id, platform").eq("workspace_id", workspaceId).is("deleted_at", null);
        if (channelsError) throw channelsError;

        // Отключаем webhook у соцсетей, пока токены ещё есть. Отозванный токен не должен мешать удалению.
        await Promise.allSettled((channels ?? []).map(async (channel) => {
          const secrets = await loadSecrets(db, channel.id);
          if (secrets) await adapters[channel.platform as Platform].deactivate(await credentialsOf(secrets));
        }));

        // Каскадное удаление: опросы, каналы, токены, клиенты, заявки, ответы, переписка, уроки, участники.
        const { error: deleteError } = await db.from("workspaces").delete().eq("id", workspaceId);
        if (deleteError) throw deleteError;

        // Учётные записи удаляем, если они не нужны другой компании и это не главный админ.
        let removedUsers = 0;
        for (const { user_id: userId } of members ?? []) {
          const { count } = await db.from("workspace_members").select("*", { count: "exact", head: true }).eq("user_id", userId);
          const { data: isAdmin } = await db.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
          if (count || isAdmin) continue;
          const { error: authError } = await db.auth.admin.deleteUser(userId);
          if (authError) console.warn("Не удалось удалить учётную запись", authError.message);
          else removedUsers++;
        }
        return json({ ok: true, removed_users: removedUsers });
      }

      default:
        throw new ChannelError("Неизвестное действие");
    }
  } catch (error) {
    return errorResponse(error);
  }
});
