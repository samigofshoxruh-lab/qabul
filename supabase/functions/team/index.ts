// Администраторы кабинета. Создание учётной записи требует секретного ключа, поэтому оно на сервере.
import { serviceClient } from "../_shared/db.ts";
import { cors, errorResponse, json, readJson, requireOwner, requireUser } from "../_shared/http.ts";
import { ChannelError } from "../_shared/types.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const db = serviceClient();
    const user = await requireUser(req, db);
    const body = await readJson(req);
    await requireOwner(db, user.id, body.workspace_id);

    if (body.action === "add") {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ChannelError("Проверьте email");
      if (password.length < 8) throw new ChannelError("Пароль должен быть не короче 8 символов");

      const { data: created, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) {
        if (/already|exists|registered/i.test(error.message)) {
          throw new ChannelError("Этот email уже зарегистрирован. Укажите другой.", 409);
        }
        throw new ChannelError(`Не удалось создать администратора: ${error.message}`, 502);
      }

      const { error: memberError } = await db.from("workspace_members").insert({
        workspace_id: body.workspace_id,
        user_id: created.user.id,
        role: "admin",
        email,
      });
      if (memberError) {
        // Не оставляем учётную запись без кабинета.
        await db.auth.admin.deleteUser(created.user.id);
        throw memberError;
      }
      return json({ ok: true });
    }

    if (body.action === "remove") {
      const userId = body.user_id;
      if (typeof userId !== "string") throw new ChannelError("Не указан администратор");
      const { data: member, error } = await db.from("workspace_members").select("role")
        .eq("workspace_id", body.workspace_id).eq("user_id", userId).maybeSingle();
      if (error) throw error;
      if (!member) throw new ChannelError("Администратор не найден", 404);
      if (member.role === "owner") throw new ChannelError("Владельца удалить нельзя");

      const { error: deleteError } = await db.from("workspace_members").delete()
        .eq("workspace_id", body.workspace_id).eq("user_id", userId);
      if (deleteError) throw deleteError;

      // Администратор создавался только для этого кабинета, поэтому его вход тоже отключаем.
      const { count } = await db.from("workspace_members").select("*", { count: "exact", head: true }).eq("user_id", userId);
      const { data: isPlatformAdmin } = await db.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
      if (!count && !isPlatformAdmin) {
        const { error: authError } = await db.auth.admin.deleteUser(userId);
        if (authError) console.warn("Не удалось удалить учётную запись", authError.message);
      }
      return json({ ok: true });
    }

    throw new ChannelError("Неизвестное действие");
  } catch (error) {
    return errorResponse(error);
  }
});
