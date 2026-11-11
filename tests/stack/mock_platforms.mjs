// Заглушка API соцсетей: отвечает как настоящие платформы и записывает все запросы.
import http from "node:http";

export function startMockPlatforms(port) {
  const calls = [];
  const failures = new Map(); // подстрока пути -> { status, body }
  let seq = 1000;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://mock");
      const raw = Buffer.concat(chunks).toString();
      let body = raw;
      try {
        if ((req.headers["content-type"] ?? "").includes("json")) body = JSON.parse(raw);
        else if (raw) body = Object.fromEntries(new URLSearchParams(raw));
      } catch { /* сырой текст */ }

      const reply = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };

      if (url.pathname === "/__calls") return reply(200, calls);
      if (url.pathname === "/__reset") {
        calls.length = 0;
        failures.clear();
        return reply(200, {});
      }
      if (url.pathname === "/__fail") {
        failures.set(body.match, { status: body.status, body: body.body });
        return reply(200, {});
      }

      calls.push({ host: req.headers["x-mock-host"], method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers });

      for (const [match, failure] of failures) {
        if (url.pathname.includes(match)) return reply(failure.status, failure.body);
      }

      const host = req.headers["x-mock-host"];
      if (host === "api.telegram.org") {
        const method = url.pathname.split("/").pop();
        if (url.pathname.includes("BAD")) return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
        if (method === "getMe") return reply(200, { ok: true, result: { id: 777001, is_bot: true, first_name: "Школа бот", username: "school_bot" } });
        if (method === "sendMessage") return reply(200, { ok: true, result: { message_id: ++seq } });
        return reply(200, { ok: true, result: true });
      }
      if (host === "graph.instagram.com") {
        if (url.pathname.endsWith("/refresh_access_token")) return reply(200, { access_token: "IG-REFRESHED-9999", token_type: "bearer", expires_in: 5184000 });
        if (url.pathname.endsWith("/me")) {
          if (url.searchParams.get("access_token") === "BAD") return reply(400, { error: { code: 190, message: "Invalid OAuth access token" } });
          return reply(200, { id: "ig-app-scoped", user_id: "17841400000000001", username: "school_uz", name: "Школа" });
        }
        if (url.pathname.endsWith("/me/subscribed_apps")) return reply(200, { success: true });
        if (url.pathname.endsWith("/me/messages")) return reply(200, { recipient_id: body.recipient?.id, message_id: `ig-out-${++seq}` });
        return reply(200, { name: "Анна Клиент", username: "anna_client" });
      }
      if (host === "graph.facebook.com") {
        const token = url.searchParams.get("access_token") ?? "";
        // Unified login: /me указывает на системного пользователя, аккаунты Instagram назначены ему.
        if (url.pathname.endsWith("/me/assigned_instagram_accounts")) {
          if (token.startsWith("EAA-UNIFIED")) return reply(200, { data: [{ id: "17841400000000002", username: "school_unified", name: "Школа U" }] });
          return reply(400, { error: { code: 100, message: "(#100) Tried accessing nonexisting field (assigned_instagram_accounts)" } });
        }
        if (url.pathname.endsWith("/app")) return reply(200, { id: "1692970000000000", name: "Qabul" });
        if (url.pathname.includes("/17841400000000099")) return reply(400, { error: { code: 100, error_subcode: 33, message: "Unsupported get request." } });
        if (url.pathname.includes("/17841400000000005")) {
          if (url.pathname.endsWith("/subscribed_apps")) return reply(200, { data: [] });
          if (url.pathname.endsWith("/messages")) return reply(200, { message_id: `igm-out-${++seq}` });
          return reply(400, { error: { code: 100, error_subcode: 33, message: "Unsupported get request." } });
        }
        if (url.pathname.endsWith("/debug_token")) {
          if (!(url.searchParams.get("access_token") ?? "").includes("|")) return reply(400, { error: { code: 100, message: "(#100) You must provide an app access token" } });
          const input = url.searchParams.get("input_token") ?? "";
          if (input.startsWith("EAA-GRANULAR")) return reply(200, { data: { type: "SYSTEM_USER", granular_scopes: [{ scope: "instagram_manage_messages", target_ids: ["17841400000000004"] }, { scope: "public_profile" }] } });
          return reply(200, { data: { type: "USER", granular_scopes: [] } });
        }
        if (url.pathname.includes("/17841400000000004")) {
          if (url.pathname.endsWith("/messages")) return reply(200, { recipient_id: body.recipient?.id, message_id: `igg-out-${++seq}` });
          if (url.pathname.endsWith("/subscribed_apps")) return reply(200, { success: true });
          return reply(400, { error: { code: 100, error_subcode: 33, message: "Unsupported get request." } });
        }
        if (url.pathname.includes("/17841400000000002/subscribed_apps")) return reply(200, { success: true });
        if (url.pathname.includes("/17841400000000002/messages")) return reply(200, { recipient_id: body.recipient?.id, message_id: `igu-out-${++seq}` });
        if (url.pathname.endsWith("/me") && token.startsWith("EAA-PAGE")) return reply(200, { id: "1000000000000001", name: "Школа Page", instagram_business_account: { id: "17841400000000003", username: "school_page" } });
        if (url.pathname.endsWith("/me/accounts")) return reply(200, { data: [] });
        if (url.pathname.endsWith("/me")) return reply(200, { id: "1000000000000001", name: "Школа Page" });
        if (url.pathname.endsWith("/me/subscribed_apps")) return reply(200, { success: true });
        if (url.pathname.endsWith("/me/messages")) return reply(200, { recipient_id: body.recipient?.id, message_id: `fb-out-${++seq}` });
        if (url.pathname.endsWith("/subscribed_apps")) return reply(200, { success: true });
        if (url.pathname.endsWith("/messages")) return reply(200, { messaging_product: "whatsapp", messages: [{ id: `wamid.${++seq}` }] });
        if (url.searchParams.get("fields")?.includes("display_phone_number")) {
          return reply(200, { id: "109000000000001", display_phone_number: "+998 90 000 00 00", verified_name: "Школа WA" });
        }
        return reply(200, { name: "Борис Клиент" });
      }
      if (host === "chatapi.viber.com") {
        const method = url.pathname.split("/").pop();
        if (method === "get_account_info") return reply(200, { status: 0, status_message: "ok", id: "pa:viber-1", name: "Школа Viber", uri: "school" });
        if (method === "send_message") return reply(200, { status: 0, status_message: "ok", message_token: ++seq });
        return reply(200, { status: 0, status_message: "ok" });
      }
      if (host === "api.vk.com") {
        const method = url.pathname.split("/").pop();
        const responses = {
          "groups.getById": { groups: [{ id: 555000, name: "Школа VK", screen_name: "school_vk" }] },
          "groups.getCallbackConfirmationCode": { code: "vk-confirm-abc" },
          "groups.getCallbackServers": { count: 0, items: [] },
          "groups.addCallbackServer": { server_id: 7 },
          "groups.setCallbackSettings": 1,
          "messages.send": ++seq,
          "users.get": [{ id: 1, first_name: "Вера", last_name: "Клиент", screen_name: "vera" }],
        };
        return reply(200, { response: responses[method] ?? 1 });
      }
      return reply(404, { error: "unknown host" });
    });
  });

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
