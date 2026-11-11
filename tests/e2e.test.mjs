// Сквозной сценарий через настоящие Edge Functions, PostgREST и Postgres.
// API соцсетей заменены заглушкой. Запуск: см. README, раздел «Тесты».
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { ANON_KEY, CRON_SECRET, GATEWAY, MOCK_URL, SERVICE_KEY, startStack } from "./stack/stack.mjs";

let stack;
const fn = (name, tail = "") => `${GATEWAY}/functions/v1/${name}${tail}`;
let seq = 0;

const mock = {
  calls: async () => (await fetch(`${MOCK_URL}/__calls`)).json(),
  reset: () => fetch(`${MOCK_URL}/__reset`),
  fail: (match, status, body) => fetch(`${MOCK_URL}/__fail`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ match, status, body }),
  }),
};
const sent = async (hostPart, pathPart) =>
  (await mock.calls()).filter((c) => c.host.includes(hostPart) && c.path.includes(pathPart));

function browser() {
  return createClient(GATEWAY, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

let boss;

async function login(email, password) {
  const client = browser();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  assert.equal(error, null);
  return { client, user: data.user };
}

// Компании создаёт главный админ через настоящую функцию platform.
async function newOwner(company = "Школа") {
  const email = `owner${Date.now()}${++seq}@example.com`;
  const created = await invoke(boss, "platform", { action: "create_company", name: company, email, password: "password123", unlimited: true });
  assert.ok(created.workspace_id, JSON.stringify(created));
  const { client, user } = await login(email, "password123");
  const { data: member } = await client.from("workspace_members").select("workspace_id").single();
  const { data: survey } = await client.from("surveys").select("*").eq("is_default", true).single();
  return { client, user, email, workspace: member.workspace_id, survey };
}

async function invoke(client, name, body) {
  const { data, error } = await client.functions.invoke(name, { body });
  if (error) {
    const payload = await error.context.json().catch(() => ({}));
    return { error: payload.error ?? error.message, status: error.context.status };
  }
  return data;
}

async function addQuestions(owner, rows) {
  const payload = rows.map((row, i) => ({ survey_id: owner.survey.id, position: i + 1, options: [], ...row }));
  const { error } = await owner.client.from("questions").insert(payload);
  assert.equal(error, null);
}

const SURVEY = [
  { type: "choice", text: "Когда удобно?", options: [{ id: "sat", label: "Суббота" }, { id: "sun", label: "Воскресенье" }] },
  { type: "text", text: "Как вас зовут?" },
  { type: "phone", text: "Ваш телефон?" },
];

before(async () => {
  stack = await startStack({ postgrestBin: process.env.POSTGREST_BIN });
  const email = `boss${Date.now()}@example.com`;
  const res = await fetch(`${GATEWAY}/auth/v1/admin/users`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ email, password: "bosspassword1", email_confirm: true }),
  });
  const { id } = await res.json();
  await stack.db.query("insert into platform_admins (user_id) values ($1)", [id]);
  ({ client: boss } = await login(email, "bosspassword1"));
});
after(async () => {
  await stack.stop();
});
beforeEach(async () => {
  await mock.reset();
  // Заглушка возвращает одни и те же аккаунты, поэтому каждый тест начинает без подключённых каналов.
  await stack.db.query("update channels set deleted_at = now() where deleted_at is null");
});

const metaSign = (secret, raw) => `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
const metaPost = (raw, signature) => fetch(fn("webhook", "/meta"), {
  method: "POST",
  headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
  body: raw,
});

async function secretOf(channelId) {
  return (await stack.db.query("select * from channel_secrets where channel_id = $1", [channelId])).rows[0];
}

test("Telegram-бот: подключение, опрос, заявка на сайте, ответ администратора", async () => {
  const owner = await newOwner();
  await addQuestions(owner, SURVEY);

  const bad = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "telegram", token: "BAD" });
  assert.match(bad.error, /не принял токен/);

  const TOKEN = `123:TELEGRAM-${Date.now()}`;
  const { channel, setup, warning } = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "telegram", token: TOKEN });
  assert.equal(channel.status, "active");
  assert.equal(channel.name, "Школа бот");
  assert.equal(setup, null);
  assert.equal(warning, null);
  assert.equal(channel.token_hint, `••••${TOKEN.slice(-4)}`);

  const [hook] = await sent("telegram", "setWebhook");
  assert.equal(hook.body.url, `${GATEWAY}/functions/v1/webhook/${channel.id}`);
  assert.deepEqual(hook.body.allowed_updates, ["message", "callback_query", "business_connection", "business_message"]);

  // Токен в базе зашифрован, браузер его не получает.
  const secret = await secretOf(channel.id);
  assert.ok(!JSON.stringify(secret).includes(TOKEN));
  assert.equal(hook.body.secret_token, secret.webhook_secret);
  const { data: visible, error: secretErr } = await owner.client.from("channel_secrets").select("*");
  assert.ok(secretErr || visible.length === 0);

  const post = (update, header = secret.webhook_secret) => fetch(fn("webhook", `/${channel.id}`), {
    method: "POST",
    headers: { "content-type": "application/json", ...(header ? { "x-telegram-bot-api-secret-token": header } : {}) },
    body: JSON.stringify(update),
  });
  const from = { id: 5001, first_name: "Анна", last_name: "К", username: "anna" };
  const message = (id, text) => ({ update_id: id, message: { message_id: id, from, chat: { id: 5001, type: "private" }, date: 1, text } });

  assert.equal((await post(message(1, "привет"), "wrong")).status, 401);
  assert.equal((await post(message(1, "привет"), null)).status, 401);
  assert.equal((await sent("telegram", "sendMessage")).length, 0);

  assert.equal((await post(message(1, "привет"))).status, 200);
  let out = await sent("telegram", "sendMessage");
  assert.equal(out.length, 2);
  assert.match(out[0].body.text, /Здравствуйте/);
  assert.equal(out[1].body.text, "Когда удобно?");
  assert.deepEqual(out[1].body.reply_markup.inline_keyboard, [
    [{ text: "Суббота", callback_data: "o:sat" }],
    [{ text: "Воскресенье", callback_data: "o:sun" }],
  ]);

  // Повторная доставка того же сообщения ничего не отправляет.
  await post(message(1, "привет"));
  assert.equal((await sent("telegram", "sendMessage")).length, 2);

  // Групповой чат бот игнорирует.
  await post({ update_id: 9, message: { message_id: 9, from, chat: { id: -100, type: "group" }, text: "всем привет" } });
  assert.equal((await sent("telegram", "sendMessage")).length, 2);

  await post({ update_id: 2, callback_query: { id: "cb-1", from, data: "o:sun", message: { message_id: 1002, chat: { id: 5001, type: "private" } } } });
  assert.equal((await sent("telegram", "answerCallbackQuery")).length, 1);
  assert.equal((await sent("telegram", "editMessageReplyMarkup"))[0].body.message_id, 1002);
  out = await sent("telegram", "sendMessage");
  assert.equal(out.at(-1).body.text, "Как вас зовут?");

  await post(message(3, "Анна"));
  await post(message(4, "телефон не дам"));
  out = await sent("telegram", "sendMessage");
  assert.match(out.at(-1).body.text, /ошибка/);
  await post(message(5, "+998901234567"));
  out = await sent("telegram", "sendMessage");
  assert.match(out.at(-1).body.text, /Спасибо/);

  // То, что видит администратор на сайте.
  const { data: leads } = await owner.client.from("leads").select("*, contacts(*), answers(*), messages(*)");
  assert.equal(leads.length, 1);
  const lead = leads[0];
  assert.equal(lead.status, "new");
  assert.equal(lead.contacts.display_name, "Анна К");
  assert.equal(lead.contacts.username, "anna");
  assert.equal(lead.contacts.phone, "+998901234567");
  assert.deepEqual(lead.answers.sort((a, b) => a.position - b.position).map((a) => a.answer_text), ["Воскресенье", "Анна", "+998901234567"]);
  assert.ok(lead.messages.every((m) => m.status !== "queued" && m.status !== "failed"));

  const { error: takeError } = await owner.client.rpc("take_lead", { p_lead_id: lead.id });
  assert.equal(takeError, null);

  await mock.reset();
  const reply = await invoke(owner.client, "send-message", { lead_id: lead.id, text: "Записал вас на воскресенье!" });
  assert.equal(reply.ok, true);
  [out] = [await sent("telegram", "sendMessage")];
  assert.equal(out[0].body.chat_id, "5001");
  assert.equal(out[0].body.text, "Записал вас на воскресенье!");

  // Чужой пользователь ни прочитать заявку, ни написать в неё не может.
  const stranger = await newOwner("Чужая школа");
  const { data: noLeads } = await stranger.client.from("leads").select("id");
  assert.deepEqual(noLeads, []);
  const denied = await invoke(stranger.client, "send-message", { lead_id: lead.id, text: "спам" });
  assert.equal(denied.status, 404);
  const deniedCheck = await invoke(stranger.client, "channels", { action: "check", channel_id: channel.id });
  assert.equal(deniedCheck.status, 403);
  const deniedConnect = await invoke(stranger.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "telegram", token: "1:x" });
  assert.equal(deniedConnect.status, 403);
  const stolen = await invoke(stranger.client, "channels", { action: "connect", workspace_id: stranger.workspace, platform: "telegram", token: "1:x" });
  assert.match(stolen.error, /другом кабинете/);

  // Без входа функции недоступны.
  const anonymous = await fetch(fn("channels"), { method: "POST", body: "{}" });
  assert.equal(anonymous.status, 401);

  // Отключение: webhook снимается, история остаётся.
  const off = await invoke(owner.client, "channels", { action: "disconnect", channel_id: channel.id });
  assert.equal(off.ok, true);
  assert.equal((await sent("telegram", "deleteWebhook")).length, 1);
  assert.equal((await post(message(6, "ещё"))).status, 404);
  assert.equal(await secretOf(channel.id), undefined);
  const { data: kept } = await owner.client.from("leads").select("id");
  assert.equal(kept.length, 1);
});

test("Telegram Business: ответ от личного аккаунта, сообщение владельца останавливает бота", async () => {
  const owner = await newOwner();
  await addQuestions(owner, SURVEY);
  const { channel } = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "telegram", token: "123:BUSINESS" });
  const secret = await secretOf(channel.id);
  const post = (update) => fetch(fn("webhook", `/${channel.id}`), {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret.webhook_secret },
    body: JSON.stringify(update),
  });
  const customer = { id: 6001, first_name: "Клиент" };
  const ownerUser = { id: 42, first_name: "Владелец" };
  const chat = { id: 6001, type: "private" };

  await post({ update_id: 1, business_message: { business_connection_id: "bc-1", message_id: 1, from: customer, chat, text: "Здравствуйте" } });
  let out = await sent("telegram", "sendMessage");
  assert.equal(out.length, 2);
  assert.ok(out.every((c) => c.body.business_connection_id === "bc-1"));
  assert.ok(out[1].body.reply_markup.inline_keyboard, "только inline-кнопки: обычная клавиатура в Business не работает");

  // Кнопка в бизнес-чате.
  await post({ update_id: 2, callback_query: { id: "cb-2", from: customer, data: "o:sat", message: { message_id: 50, business_connection_id: "bc-1", chat } } });
  out = await sent("telegram", "sendMessage");
  assert.equal(out.at(-1).body.text, "Как вас зовут?");
  assert.equal(out.at(-1).body.business_connection_id, "bc-1");
  assert.equal((await sent("telegram", "editMessageReplyMarkup"))[0].body.business_connection_id, "bc-1");

  // Своё сообщение бота, пришедшее обратно, ни на что не влияет.
  await post({ update_id: 3, business_message: { business_connection_id: "bc-1", message_id: 3, from: ownerUser, chat, sender_business_bot: { id: 777001 }, text: "Как вас зовут?" } });
  const { data: stillCollecting } = await owner.client.from("leads").select("status").single();
  assert.equal(stillCollecting.status, "collecting");

  // Владелец написал сам: бот останавливается, реплика видна на сайте.
  const before = (await sent("telegram", "sendMessage")).length;
  await post({ update_id: 4, business_message: { business_connection_id: "bc-1", message_id: 4, from: ownerUser, chat, text: "Добрый день, это Анна, подскажу лично" } });
  const { data: lead } = await owner.client.from("leads").select("status, messages(sender, text)").single();
  assert.equal(lead.status, "in_work");
  assert.ok(lead.messages.some((m) => m.sender === "agent" && m.text.includes("это Анна")));

  await post({ update_id: 5, business_message: { business_connection_id: "bc-1", message_id: 5, from: customer, chat, text: "Спасибо" } });
  assert.equal((await sent("telegram", "sendMessage")).length, before);
});

test("Instagram: настройка webhook, подпись, кнопки, эхо, длинные варианты, продление токена", async () => {
  const owner = await newOwner();
  await addQuestions(owner, [
    { type: "choice", text: "Когда удобно?", options: [{ id: "a", label: "Суббота" }, { id: "b", label: "Воскресенье" }] },
    { type: "choice", text: "Какой филиал?", options: [{ id: "c", label: "Чиланзар, улица Катартал, дом 5" }, { id: "d", label: "Юнусабад" }] },
    { type: "text", text: "Как вас зовут?" },
  ]);

  const noSecret = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "instagram", token: "IG" });
  assert.match(noSecret.error, /App Secret/);
  const badToken = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "instagram", token: "BAD", app_secret: "s" });
  assert.match(badToken.error, /недействителен/);

  const APP_SECRET = "ig-app-secret";
  const res = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "instagram", token: "IG-LONG-TOKEN-1234", app_secret: APP_SECRET });
  assert.equal(res.channel.external_id, "17841400000000001", "используем user_id, он приходит в webhook как entry.id");
  assert.equal(res.channel.name, "@school_uz");
  assert.equal(res.channel.status, "pending");
  assert.ok(res.channel.token_expires_at);
  assert.equal(res.setup.callback_url, `${GATEWAY}/functions/v1/webhook/meta`);
  const [subscribe] = await sent("instagram", "subscribed_apps");
  assert.equal(subscribe.query.subscribed_fields, "messages,messaging_postbacks");

  const again = await invoke(owner.client, "channels", { action: "setup", channel_id: res.channel.id });
  assert.equal(again.setup.verify_token, res.setup.verify_token);

  // Проверка адреса со стороны Meta.
  const verify = (token) => fetch(fn("webhook", `/meta?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=${token}`));
  const good = await verify(res.setup.verify_token);
  assert.equal(good.status, 200);
  assert.equal(await good.text(), "1158201444");
  assert.equal((await verify("wrong")).status, 403);

  const event = (messaging) => JSON.stringify({ object: "instagram", entry: [{ id: "17841400000000001", time: 1, messaging: [messaging] }] });
  const incoming = (mid, message) => ({ sender: { id: "igsid-1" }, recipient: { id: "17841400000000001" }, timestamp: 1, message: { mid, ...message } });

  const raw = event(incoming("m1", { text: "Привет" }));
  assert.equal((await metaPost(raw)).status, 401);
  assert.equal((await metaPost(raw, metaSign("wrong-secret", raw))).status, 401);
  assert.equal((await sent("instagram", "me/messages")).length, 0);
  const { data: errored } = await owner.client.from("channels").select("last_error").single();
  assert.match(errored.last_error, /App Secret/);

  assert.equal((await metaPost(raw, metaSign(APP_SECRET, raw))).status, 200);
  let out = await sent("instagram", "me/messages");
  assert.equal(out.length, 2);
  assert.equal(out[1].body.recipient.id, "igsid-1");
  assert.deepEqual(out[1].body.message.quick_replies, [
    { content_type: "text", title: "Суббота", payload: "o:a" },
    { content_type: "text", title: "Воскресенье", payload: "o:b" },
  ]);

  // Статус канала стал рабочим, ошибка настройки исчезла вместе с первым событием.
  const { data: live } = await owner.client.from("channels").select("status, last_event_at, last_error").single();
  assert.equal(live.status, "active");
  assert.ok(live.last_event_at);
  assert.equal(live.last_error, null);

  // Повторная проверка не сбрасывает рабочий канал обратно в ожидание.
  const rechecked = await invoke(owner.client, "channels", { action: "check", channel_id: res.channel.id });
  assert.equal(rechecked.channel.status, "active");
  await mock.reset();

  // Имя подтянулось из профиля.
  const { data: contact } = await owner.client.from("contacts").select("display_name, username").single();
  assert.deepEqual(contact, { display_name: "Анна Клиент", username: "anna_client" });

  // Эхо своего сообщения: бот не должен ответить сам себе.
  const echoRaw = event({ sender: { id: "17841400000000001" }, recipient: { id: "igsid-1" }, message: { mid: "echo", text: "Когда удобно?", is_echo: true } });
  await metaPost(echoRaw, metaSign(APP_SECRET, echoRaw));
  const echoRaw2 = event({ sender: { id: "igsid-1" }, recipient: { id: "17841400000000001" }, message: { mid: "echo2", text: "x", is_echo: true } });
  await metaPost(echoRaw2, metaSign(APP_SECRET, echoRaw2));
  // Отметка о прочтении не является сообщением.
  const readRaw = event({ sender: { id: "igsid-1" }, recipient: { id: "17841400000000001" }, read: { mid: "m1" } });
  await metaPost(readRaw, metaSign(APP_SECRET, readRaw));
  assert.equal((await sent("instagram", "me/messages")).length, 0, "после сброса заглушки бот ничего не отправил");

  const quick = event(incoming("m2", { text: "Суббота", quick_reply: { payload: "o:a" } }));
  await metaPost(quick, metaSign(APP_SECRET, quick));
  out = await sent("instagram", "me/messages");
  // Подпись длиннее 20 символов: варианты в тексте, на кнопках номера.
  assert.match(out.at(-1).body.message.text, /1\. Чиланзар, улица Катартал, дом 5/);
  assert.deepEqual(out.at(-1).body.message.quick_replies.map((q) => [q.title, q.payload]), [["1", "o:c"], ["2", "o:d"]]);

  // Клиент отвечает цифрой.
  const typed = event(incoming("m3", { text: "1" }));
  await metaPost(typed, metaSign(APP_SECRET, typed));
  out = await sent("instagram", "me/messages");
  assert.equal(out.at(-1).body.message.text, "Как вас зовут?");

  // Ошибка платформы при отправке видна на сайте, а Meta получает 200 и не повторяет webhook.
  await mock.fail("me/messages", 400, { error: { code: 10, error_subcode: 2534022, message: "outside window" } });
  const failing = event(incoming("m4", { text: "Анна" }));
  assert.equal((await metaPost(failing, metaSign(APP_SECRET, failing))).status, 200);
  const { data: failed } = await owner.client.from("messages").select("status, error").eq("status", "failed");
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /24 часов/);
  const { data: noChannelError } = await owner.client.from("channels").select("last_error").single();
  assert.equal(noChannelError.last_error, null, "окно 24 часа касается одного клиента, а не канала");

  // Истёкший токен виден на карточке канала, успешная отправка снимает ошибку.
  await mock.reset();
  await mock.fail("me/messages", 400, { error: { code: 190, message: "Token expired" } });
  const { data: leadRow } = await owner.client.from("leads").select("id").single();
  await invoke(owner.client, "send-message", { lead_id: leadRow.id, text: "Проверка" });
  const { data: tokenError } = await owner.client.from("channels").select("last_error").single();
  assert.match(tokenError.last_error, /истёк/);
  await mock.reset();
  await invoke(owner.client, "send-message", { lead_id: leadRow.id, text: "Проверка 2" });
  const { data: cleared } = await owner.client.from("channels").select("last_error").single();
  assert.equal(cleared.last_error, null);

  // Продление токена: только с секретом и только скоро истекающие.
  await stack.db.query("update channels set token_expires_at = now() + interval '5 days' where id = $1", [res.channel.id]);
  assert.equal((await fetch(fn("refresh-tokens"), { method: "POST" })).status, 401);
  const refresh = await fetch(fn("refresh-tokens"), { method: "POST", headers: { "x-cron-secret": CRON_SECRET } });
  assert.equal(refresh.status, 200);
  const { refreshed } = await refresh.json();
  assert.ok(refreshed.some((r) => r.id === res.channel.id && r.ok));
  const { data: renewed } = await owner.client.from("channels").select("token_hint, token_expires_at").single();
  assert.equal(renewed.token_hint, "••••9999");
  assert.ok(new Date(renewed.token_expires_at) > new Date(Date.now() + 50 * 86400000));

  // Новый токен реально используется при отправке.
  const after = event(incoming("m5", { text: "ещё сообщение" }));
  await metaPost(after, metaSign(APP_SECRET, after));
  const { data: lead } = await owner.client.from("leads").select("id").single();
  await invoke(owner.client, "send-message", { lead_id: lead.id, text: "Ответ" });
  out = await sent("instagram", "me/messages");
  assert.equal(out.at(-1).query.access_token, "IG-REFRESHED-9999");
});

test("Facebook Messenger: страница, кнопка, ответ", async () => {
  const owner = await newOwner();
  await addQuestions(owner, SURVEY);
  const APP_SECRET = "fb-secret";
  const res = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "facebook", token: "PAGE-TOKEN", app_secret: APP_SECRET });
  assert.equal(res.channel.external_id, "1000000000000001");
  assert.ok(res.setup.verify_token);

  const event = (message) => JSON.stringify({ object: "page", entry: [{ id: "1000000000000001", time: 1, messaging: [{ sender: { id: "psid-1" }, recipient: { id: "1000000000000001" }, timestamp: 1, message }] }] });
  const hi = event({ mid: "fb1", text: "Здравствуйте" });
  assert.equal((await metaPost(hi, metaSign(APP_SECRET, hi))).status, 200);
  let out = await sent("facebook", "me/messages");
  assert.equal(out.length, 2);
  assert.equal(out[1].body.messaging_type, "RESPONSE");

  const quick = event({ mid: "fb2", text: "Воскресенье", quick_reply: { payload: "o:sun" } });
  await metaPost(quick, metaSign(APP_SECRET, quick));
  out = await sent("facebook", "me/messages");
  assert.equal(out.at(-1).body.message.text, "Как вас зовут?");
  const { data: contact } = await owner.client.from("contacts").select("display_name").single();
  assert.equal(contact.display_name, "Борис Клиент");
  const { data: answer } = await owner.client.from("answers").select("answer_text").single();
  assert.equal(answer.answer_text, "Воскресенье");
});

test("WhatsApp: кнопки до 3, список до 10, ответы кнопкой, статусы игнорируются", async () => {
  const owner = await newOwner();
  await addQuestions(owner, [
    SURVEY[0],
    { type: "choice", text: "Какой курс?", options: [{ id: "a", label: "Английский" }, { id: "b", label: "Немецкий" }, { id: "c", label: "Корейский" }, { id: "d", label: "Французский" }] },
    { type: "text", text: "Как вас зовут?" },
  ]);
  const APP_SECRET = "wa-secret";
  const missing = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "whatsapp", token: "WA", app_secret: APP_SECRET });
  assert.match(missing.error, /Phone number ID/);
  const res = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "whatsapp", token: "WA-TOKEN", app_secret: APP_SECRET, phone_number_id: "109000000000001", waba_id: "2000000000001" });
  assert.equal(res.channel.external_id, "109000000000001");
  assert.equal((await sent("facebook", "2000000000001/subscribed_apps")).length, 1);

  const event = (value) => JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "2000000000001", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "998900000000", phone_number_id: "109000000000001" }, ...value } }] }],
  });
  const contact = { contacts: [{ profile: { name: "Вали" }, wa_id: "998901112233" }] };
  const hi = event({ ...contact, messages: [{ from: "998901112233", id: "wamid.1", timestamp: "1", type: "text", text: { body: "Салом" } }] });
  await metaPost(hi, metaSign(APP_SECRET, hi));
  let out = await sent("facebook", "109000000000001/messages");
  assert.equal(out.length, 2);
  assert.equal(out[0].body.type, "text");
  assert.equal(out[1].body.interactive.type, "button");
  assert.deepEqual(out[1].body.interactive.action.buttons[0], { type: "reply", reply: { id: "o:sat", title: "Суббота" } });

  const status = event({ statuses: [{ id: "wamid.x", status: "read", recipient_id: "998901112233" }] });
  assert.equal((await metaPost(status, metaSign(APP_SECRET, status))).status, 200);

  const tap = event({ ...contact, messages: [{ from: "998901112233", id: "wamid.2", timestamp: "2", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "o:sun", title: "Воскресенье" } } }] });
  await metaPost(tap, metaSign(APP_SECRET, tap));
  out = await sent("facebook", "109000000000001/messages");
  assert.equal(out.length, 3);
  assert.equal(out[2].body.interactive.type, "list");
  assert.equal(out[2].body.interactive.action.sections[0].rows.length, 4);

  const pick = event({ ...contact, messages: [{ from: "998901112233", id: "wamid.3", timestamp: "3", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "o:c", title: "Корейский" } } }] });
  await metaPost(pick, metaSign(APP_SECRET, pick));
  out = await sent("facebook", "109000000000001/messages");
  assert.equal(out.at(-1).body.text.body, "Как вас зовут?");

  const { data: lead } = await owner.client.from("leads").select("answers(answer_text), contacts(display_name)").single();
  assert.deepEqual(lead.answers.map((a) => a.answer_text).sort(), ["Воскресенье", "Корейский"]);
  assert.equal(lead.contacts.display_name, "Вали");
});

test("Viber: подпись, приветствие до подписки, клавиатура", async () => {
  const owner = await newOwner();
  await addQuestions(owner, SURVEY);
  const TOKEN = "viber-token-1";
  const { channel } = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "viber", token: TOKEN });
  assert.equal(channel.status, "active");
  const [hook] = await sent("viber", "set_webhook");
  assert.equal(hook.body.url, `${GATEWAY}/functions/v1/webhook/${channel.id}`);
  assert.equal(hook.headers["x-viber-auth-token"], TOKEN);

  const post = (body, token = TOKEN) => {
    const raw = JSON.stringify(body);
    return fetch(fn("webhook", `/${channel.id}`), {
      method: "POST",
      headers: { "content-type": "application/json", "x-viber-content-signature": crypto.createHmac("sha256", token).update(raw).digest("hex") },
      body: raw,
    });
  };
  assert.equal((await post({ event: "webhook", timestamp: 1 })).status, 200);
  const started = await post({ event: "conversation_started", user: { id: "v1", name: "Вика" } });
  assert.match((await started.json()).text, /Здравствуйте/);

  const hi = { event: "message", timestamp: 1, message_token: 111, sender: { id: "v1", name: "Вика" }, message: { type: "text", text: "Привет" } };
  assert.equal((await post(hi, "forged")).status, 401);
  assert.equal((await post(hi)).status, 200);
  let out = await sent("viber", "send_message");
  assert.equal(out.length, 2);
  assert.equal(out[1].body.receiver, "v1");
  assert.equal(out[1].body.keyboard.Buttons[1].ActionBody, "Воскресенье");
  assert.equal(out[1].body.sender.name, "Школа Viber");

  await post({ ...hi, message_token: 112, message: { type: "text", text: "Воскресенье" } });
  out = await sent("viber", "send_message");
  assert.equal(out.at(-1).body.text, "Как вас зовут?");
  assert.equal(out.at(-1).body.keyboard, undefined);

  await post({ ...hi, message_token: 113, message: { type: "picture", media: "http://x" } });
  out = await sent("viber", "send_message");
  assert.match(out.at(-1).body.text, /понимаю только текст/);
  await post({ event: "delivered", message_token: 114, user_id: "v1" });
  assert.equal((await sent("viber", "send_message")).length, out.length);
});

test("VK: подтверждение сервера, секрет, клавиатура с payload, беседы игнорируются", async () => {
  const owner = await newOwner();
  await addQuestions(owner, SURVEY);
  const { channel } = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "vk", token: "vk-token" });
  assert.equal(channel.external_id, "555000");
  assert.equal(channel.status, "active");

  const calls = await mock.calls();
  const order = calls.map((c) => c.path.split("/").pop());
  assert.ok(order.indexOf("groups.getCallbackConfirmationCode") < order.indexOf("groups.addCallbackServer"), "код подтверждения сохраняется раньше добавления сервера");
  const settings = calls.find((c) => c.path.endsWith("groups.setCallbackSettings"));
  assert.equal(settings.body.message_new, "1");
  assert.equal(settings.body.server_id, "7");
  const secret = await secretOf(channel.id);
  assert.equal(calls.find((c) => c.path.endsWith("groups.addCallbackServer")).body.secret_key, secret.webhook_secret);

  const post = (body) => fetch(fn("webhook", `/${channel.id}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const confirm = await post({ type: "confirmation", group_id: 555000 });
  assert.equal(await confirm.text(), "vk-confirm-abc");
  assert.equal((await post({ type: "confirmation", group_id: 1 })).status, 401);

  const message = (id, extra) => ({
    type: "message_new", group_id: 555000, event_id: `e${id}`, v: "5.199", secret: secret.webhook_secret,
    object: { message: { id, from_id: 9001, peer_id: 9001, date: 1, ...extra }, client_info: {} },
  });
  assert.equal((await post({ ...message(1, { text: "Привет" }), secret: "wrong" })).status, 401);
  const res = await post(message(1, { text: "Привет" }));
  assert.equal(await res.text(), "ok", "VK требует ответ ok");
  let out = await sent("vk", "messages.send");
  assert.equal(out.length, 2);
  const keyboard = JSON.parse(out[1].body.keyboard);
  assert.equal(keyboard.buttons[0][0].action.label, "Суббота");
  assert.equal(keyboard.buttons[1][0].action.payload, JSON.stringify({ o: "sun" }));

  await post(message(2, { text: "Воскресенье", payload: JSON.stringify({ o: "sun" }) }));
  out = await sent("vk", "messages.send");
  assert.equal(out.at(-1).body.message, "Как вас зовут?");
  const { data: answer } = await owner.client.from("answers").select("option_id").single();
  assert.equal(answer.option_id, "sun");

  // Сообщение из беседы не запускает опрос.
  await post({ ...message(3, { text: "всем" }), object: { message: { id: 3, from_id: 9002, peer_id: 2000000001, text: "всем" } } });
  assert.equal((await sent("vk", "messages.send")).length, out.length);

  const { data: contact } = await owner.client.from("contacts").select("display_name").single();
  assert.equal(contact.display_name, "Вера Клиент");
});

test("Канал с ошибкой токена помечается, повторное подключение обновляет токен и сохраняет адрес", async () => {
  const owner = await newOwner();
  const first = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "viber", token: "t1" });
  const secret1 = await secretOf(first.channel.id);
  await mock.fail("set_webhook", 200, { status: 1, status_message: "invalidUrl" });
  const failed = await invoke(owner.client, "channels", { action: "check", channel_id: first.channel.id });
  assert.match(failed.error, /invalidUrl/);
  const { data: broken } = await owner.client.from("channels").select("status, last_error").single();
  assert.equal(broken.status, "error");
  assert.match(broken.last_error, /invalidUrl/);

  // Токен отозван: «Проверить» показывает ошибку на карточке.
  await mock.reset();
  await mock.fail("get_account_info", 200, { status: 2, status_message: "invalidAuthToken" });
  const revoked = await invoke(owner.client, "channels", { action: "check", channel_id: first.channel.id });
  assert.match(revoked.error, /не принял токен/);
  const { data: revokedRow } = await owner.client.from("channels").select("status, last_error").single();
  assert.equal(revokedRow.status, "error");
  assert.match(revokedRow.last_error, /не принял токен/);

  await mock.reset();
  const second = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "viber", token: "t2-new" });
  assert.equal(second.channel.id, first.channel.id);
  assert.equal(second.channel.status, "active");
  assert.equal(second.channel.last_error, null);
  assert.equal(second.channel.token_hint, "••••-new");
  const secret2 = await secretOf(first.channel.id);
  assert.equal(secret2.webhook_secret, secret1.webhook_secret);
  assert.notEqual(secret2.token_enc, secret1.token_enc);
  await invoke(owner.client, "channels", { action: "disconnect", channel_id: first.channel.id });
});

test("Команда: владелец добавляет и удаляет администратора, администратор работает с заявками", async () => {
  const owner = await newOwner();
  await addQuestions(owner, SURVEY);
  const email = `admin${Date.now()}@example.com`;

  assert.match((await invoke(owner.client, "team", { action: "add", workspace_id: owner.workspace, email, password: "123" })).error, /8 символов/);
  assert.equal((await invoke(owner.client, "team", { action: "add", workspace_id: owner.workspace, email, password: "password123" })).ok, true);
  assert.match((await invoke(owner.client, "team", { action: "add", workspace_id: owner.workspace, email, password: "password123" })).error, /уже зарегистрирован/);

  const admin = browser();
  const { error: loginError, data: login } = await admin.auth.signInWithPassword({ email, password: "password123" });
  assert.equal(loginError, null);

  const { data: members } = await admin.from("workspace_members").select("role, email");
  assert.equal(members.length, 2, "сотрудник действительно состоит в кабинете");
  assert.equal(members.find((m) => m.email === email).role, "admin");
  const { data: seenByOwner } = await owner.client.from("workspace_members").select("email");
  assert.ok(seenByOwner.some((m) => m.email === email), "владелец видит сотрудника в списке");
  assert.equal((await admin.rpc("my_access")).data.memberships[0].active, true);

  // Администратор не трогает каналы, команду и вопросы.
  const noChannel = await invoke(admin, "channels", { action: "connect", workspace_id: owner.workspace, platform: "telegram", token: "1:x" });
  assert.equal(noChannel.status, 403);
  assert.equal((await invoke(admin, "team", { action: "add", workspace_id: owner.workspace, email: "x@example.com", password: "password123" })).status, 403);
  const { error: noQuestion } = await admin.from("questions").insert({ survey_id: owner.survey.id, text: "x" });
  assert.ok(noQuestion);

  // Заявки ему доступны.
  const { channel } = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "telegram", token: "123:TEAM" });
  const secret = await secretOf(channel.id);
  await fetch(fn("webhook", `/${channel.id}`), {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret.webhook_secret },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: 7 }, chat: { id: 7, type: "private" }, text: "hi" } }),
  });
  const { data: lead } = await admin.from("leads").select("id").single();
  assert.equal((await admin.rpc("take_lead", { p_lead_id: lead.id })).error, null);
  assert.equal((await invoke(admin, "send-message", { lead_id: lead.id, text: "Здравствуйте" })).ok, true);
  const taken = await owner.client.rpc("take_lead", { p_lead_id: lead.id });
  assert.match(taken.error.message, new RegExp(email));

  // После удаления вход и данные закрыты, история заявки на месте.
  assert.match((await invoke(owner.client, "team", { action: "remove", workspace_id: owner.workspace, user_id: owner.user.id })).error, /Владельца/);
  assert.equal((await invoke(owner.client, "team", { action: "remove", workspace_id: owner.workspace, user_id: login.user.id })).ok, true);
  const { rows } = await stack.db.query("select 1 from auth.users where email = $1", [email]);
  assert.equal(rows.length, 0);
  const { data: messages } = await owner.client.from("messages").select("text").eq("sender", "agent");
  assert.equal(messages[0].text, "Здравствуйте");
  await invoke(owner.client, "channels", { action: "disconnect", channel_id: channel.id });
});

test("Главный админ: компании, пользователи, сроки, а обычному владельцу консоль закрыта", async () => {
  // Регистрации нет.
  const { error: signupError } = await browser().auth.signUp({ email: "new@example.com", password: "password123" });
  assert.match(signupError.message, /not allowed/i);

  const email = `client${Date.now()}@example.com`;
  const bad = await invoke(boss, "platform", { action: "create_company", name: "Х", email, password: "short", months: 1 });
  assert.match(bad.error, /8 символов/);
  const noTerm = await invoke(boss, "platform", { action: "create_company", name: "Х", email, password: "password123" });
  assert.match(noTerm.error, /срок/);

  const created = await invoke(boss, "platform", { action: "create_company", name: "Учебный центр", email, password: "password123", months: 1 });
  assert.ok(created.workspace_id);
  const duplicate = await invoke(boss, "platform", { action: "create_company", name: "Дубль", email, password: "password123", months: 1 });
  assert.match(duplicate.error, /уже зарегистрирован/);

  const list = async () => (await invoke(boss, "platform", { action: "overview" })).companies;
  const find = async () => (await list()).find((c) => c.id === created.workspace_id);
  let company = await find();
  assert.equal(company.name, "Учебный центр");
  assert.equal(company.members[0].role, "owner");
  const days = (new Date(company.access_until) - Date.now()) / 86400000;
  assert.ok(days > 27 && days < 32, `месяц, а получилось ${days}`);

  const { client: owner } = await login(email, "password123");
  const access = async (c = owner) => (await c.rpc("my_access")).data;
  assert.equal((await access()).memberships[0].active, true);
  assert.equal((await access()).is_platform_admin, false);

  // Владельцу консоль закрыта, даже если он знает адрес функции.
  for (const body of [
    { action: "overview" },
    { action: "set_access", workspace_id: created.workspace_id, unlimited: true },
    { action: "create_company", name: "x", email: "x@example.com", password: "password123", months: 1 },
  ]) {
    assert.equal((await invoke(owner, "platform", body)).status, 403);
  }

  // Канал работает, пока срок идёт.
  const { data: survey } = await owner.from("surveys").select("id").single();
  await owner.from("questions").insert({ survey_id: survey.id, position: 1, type: "text", text: "Как вас зовут?", options: [] });
  const { channel } = await invoke(owner, "channels", { action: "connect", workspace_id: created.workspace_id, platform: "telegram", token: "123:TERM" });
  assert.ok(channel);
  const secret = await secretOf(channel.id);
  const say = (id) => fetch(fn("webhook", `/${channel.id}`), {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret.webhook_secret },
    body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: 11, first_name: "К" }, chat: { id: 11, type: "private" }, text: "привет" } }),
  });
  await say(1);
  assert.equal((await sent("telegram", "sendMessage")).length, 2);

  // Срок истёк: кабинет закрыт, бот молчит, повторно подключить канал нельзя.
  await mock.reset();
  assert.equal((await invoke(boss, "platform", { action: "set_access", workspace_id: created.workspace_id, until: new Date(Date.now() - 86400000).toISOString() })).ok, true);
  assert.equal((await access()).memberships[0].active, false);
  assert.deepEqual((await owner.from("leads").select("id")).data, []);
  assert.equal((await invoke(owner, "channels", { action: "connect", workspace_id: created.workspace_id, platform: "telegram", token: "123:TERM" })).status, 403);
  assert.equal((await invoke(owner, "team", { action: "add", workspace_id: created.workspace_id, email: "a@example.com", password: "password123" })).status, 403);
  const { data: leadRow } = await stack.db.query("select id from leads where workspace_id = $1", [created.workspace_id]).then((r) => ({ data: r.rows[0] }));
  assert.equal((await invoke(owner, "send-message", { lead_id: leadRow.id, text: "x" })).status, 404);
  assert.equal((await say(2)).status, 200);
  assert.equal((await sent("telegram", "sendMessage")).length, 0, "бот молчит у просроченной компании");

  // Продление открывает всё снова.
  assert.equal((await invoke(boss, "platform", { action: "set_access", workspace_id: created.workspace_id, add_months: 3 })).ok, true);
  company = await find();
  assert.ok((new Date(company.access_until) - Date.now()) / 86400000 > 85);
  assert.equal((await access()).memberships[0].active, true);
  assert.equal((await owner.from("leads").select("id")).data.length, 1);

  // Приостановка и бессрочный доступ.
  await invoke(boss, "platform", { action: "set_suspended", workspace_id: created.workspace_id, suspended: true });
  assert.equal((await access()).memberships[0].active, false);
  await invoke(boss, "platform", { action: "set_suspended", workspace_id: created.workspace_id, suspended: false });
  await invoke(boss, "platform", { action: "set_access", workspace_id: created.workspace_id, unlimited: true });
  assert.equal((await find()).access_until, null);

  // Пользователи компании и личный срок.
  const userEmail = `user${Date.now()}@example.com`;
  const added = await invoke(boss, "platform", { action: "add_user", workspace_id: created.workspace_id, email: userEmail, password: "password123", role: "admin" });
  assert.ok(added.user_id);
  const { client: staff } = await login(userEmail, "password123");
  assert.equal((await access(staff)).memberships[0].role, "admin");

  await invoke(boss, "platform", { action: "set_user_access", workspace_id: created.workspace_id, user_id: added.user_id, until: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await access(staff)).memberships[0].active, false);
  assert.equal((await access()).memberships[0].active, true, "у владельца доступ остался");
  await invoke(boss, "platform", { action: "set_user_access", workspace_id: created.workspace_id, user_id: added.user_id });
  assert.equal((await access(staff)).memberships[0].active, true);

  assert.equal((await invoke(boss, "platform", { action: "set_password", user_id: added.user_id, password: "newpassword1" })).ok, true);
  const relogin = await browser().auth.signInWithPassword({ email: userEmail, password: "password123" });
  assert.ok(relogin.error, "старый пароль больше не работает");
  await login(userEmail, "newpassword1");

  assert.equal((await invoke(boss, "platform", { action: "rename", workspace_id: created.workspace_id, name: "Новое имя" })).ok, true);
  assert.equal((await find()).name, "Новое имя");

  const onlyOwner = (await find()).members.find((m) => m.role === "owner");
  assert.match((await invoke(boss, "platform", { action: "remove_user", workspace_id: created.workspace_id, user_id: onlyOwner.user_id })).error, /единственного владельца/);
  assert.equal((await invoke(boss, "platform", { action: "remove_user", workspace_id: created.workspace_id, user_id: added.user_id })).ok, true);
  assert.equal((await stack.db.query("select 1 from auth.users where id = $1", [added.user_id])).rowCount, 0);
  assert.equal((await find()).members.length, 1);
});

test("Главный админ удаляет компанию со всеми данными, другие компании и его аккаунт не затронуты", async () => {
  const victim = await newOwner("Удаляемая школа");
  const other = await newOwner("Другая школа");
  await addQuestions(victim, SURVEY);
  await addQuestions(other, SURVEY);

  // Наполняем обе компании: канал, заявка с ответом и перепиской, урок с учеником, сотрудник.
  const { channel: victimChannel } = await invoke(victim.client, "channels", { action: "connect", workspace_id: victim.workspace, platform: "viber", token: "viber-del" });
  const secretRow = await secretOf(victimChannel.id);
  const raw = JSON.stringify({ event: "message", message_token: 501, sender: { id: "del1", name: "Клиент" }, message: { type: "text", text: "Привет" } });
  const posted = await fetch(fn("webhook", `/${victimChannel.id}`), {
    method: "POST",
    headers: { "content-type": "application/json", "x-viber-content-signature": crypto.createHmac("sha256", "viber-del").update(raw).digest("hex") },
    body: raw,
  });
  assert.equal(posted.status, 200);
  assert.ok(secretRow);

  const { data: contact } = await victim.client.from("contacts").select("id").single();
  const { data: lesson } = await victim.client.from("lessons").insert({ workspace_id: victim.workspace, title: "Урок" }).select().single();
  await victim.client.from("lesson_students").insert({ workspace_id: victim.workspace, lesson_id: lesson.id, contact_id: contact.id, name: "Клиент" });
  const staffEmail = `del-staff${Date.now()}@example.com`;
  assert.equal((await invoke(victim.client, "team", { action: "add", workspace_id: victim.workspace, email: staffEmail, password: "password123" })).ok, true);
  await other.client.from("lessons").insert({ workspace_id: other.workspace, title: "Чужой урок" });

  // Главный админ в компании: его аккаунт должен уцелеть.
  const { rows: [bossRow] } = await stack.db.query("select user_id from platform_admins limit 1");
  const bossEmailRow = (await stack.db.query("select email from auth.users where id = $1", [bossRow.user_id])).rows[0];
  await invoke(boss, "platform", { action: "overview" });
  await stack.db.query("insert into workspace_members (workspace_id, user_id, role, email) values ($1, $2, 'admin', $3)", [victim.workspace, bossRow.user_id, bossEmailRow.email]);

  // Без подтверждения и без прав удалить нельзя.
  const noConfirm = await invoke(boss, "platform", { action: "delete_company", workspace_id: victim.workspace });
  assert.match(noConfirm.error, /Подтвердите/);
  const denied = await invoke(victim.client, "platform", { action: "delete_company", workspace_id: victim.workspace, confirm: true });
  assert.equal(denied.status, 403);
  assert.equal((await stack.db.query("select 1 from workspaces where id = $1", [victim.workspace])).rowCount, 1);

  // Переписка с поддержкой удаляется вместе с компанией.
  assert.equal((await victim.client.rpc("support_send", { p_workspace: victim.workspace, p_text: "Помогите" })).error, null);

  await mock.reset();
  const done = await invoke(boss, "platform", { action: "delete_company", workspace_id: victim.workspace, confirm: true });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.removed_users, 2, "владелец и сотрудник");

  // В базе не осталось ничего от этой компании.
  for (const table of ["workspace_members", "surveys", "channels", "contacts", "leads", "answers", "messages", "lessons", "lesson_students", "support_messages"]) {
    const { rowCount } = await stack.db.query(`select 1 from ${table} where workspace_id = $1`, [victim.workspace]);
    assert.equal(rowCount, 0, table);
  }
  assert.equal((await stack.db.query("select 1 from workspaces where id = $1", [victim.workspace])).rowCount, 0);
  assert.equal((await stack.db.query("select 1 from channel_secrets where channel_id = $1", [victimChannel.id])).rowCount, 0, "токены удалены");
  assert.equal((await stack.db.query("select 1 from questions q where q.survey_id = $1", [victim.survey.id])).rowCount, 0);

  // Учётные записи удалены, главный админ на месте.
  assert.equal((await stack.db.query("select 1 from auth.users where email = any($1)", [[victim.email, staffEmail]])).rowCount, 0);
  assert.equal((await browser().auth.signInWithPassword({ email: victim.email, password: "password123" })).error?.message.length > 0, true);
  assert.equal((await stack.db.query("select 1 from auth.users where id = $1", [bossRow.user_id])).rowCount, 1);
  assert.equal((await boss.rpc("my_access")).data.is_platform_admin, true);

  // Webhook снят, входящие больше не принимаются.
  assert.ok((await sent("viber", "set_webhook")).some((c) => c.body.url === ""));
  const after = await fetch(fn("webhook", `/${victimChannel.id}`), { method: "POST", headers: { "content-type": "application/json" }, body: raw });
  assert.equal(after.status, 404);

  // Другая компания цела и работает.
  assert.equal((await other.client.from("lessons").select("title")).data[0].title, "Чужой урок");
  assert.equal((await other.client.rpc("my_access")).data.memberships[0].active, true);
  const { companies } = await invoke(boss, "platform", { action: "overview" });
  assert.ok(!companies.some((c) => c.id === victim.workspace));
  assert.ok(companies.some((c) => c.id === other.workspace));
});

test("Поддержка: владелец и главный админ переписываются, продление работает, срок не мешает", async () => {
  const owner = await newOwner("Школа с вопросом");
  const staffEmail = `sup-staff${Date.now()}@example.com`;
  await invoke(owner.client, "team", { action: "add", workspace_id: owner.workspace, email: staffEmail, password: "password123" });
  const { client: staff } = await login(staffEmail, "password123");
  const stranger = await newOwner("Чужая школа");

  const send = (client, text, asPlatform = false, ws = owner.workspace) =>
    client.rpc("support_send", { p_workspace: ws, p_text: text, p_as_platform: asPlatform });

  // Только владелец этой компании и главный админ.
  assert.equal((await send(owner.client, "Прошу продлить доступ")).error, null);
  assert.match((await send(staff, "Я сотрудник")).error.message, /только владелец/);
  assert.match((await send(stranger.client, "Я чужой")).error.message, /только владелец/);
  assert.match((await send(owner.client, "Притворяюсь админом", true)).error.message, /Нет доступа/);
  assert.deepEqual((await stranger.client.from("support_messages").select("id")).data, []);
  assert.deepEqual((await staff.from("support_messages").select("id")).data, []);
  assert.equal((await stranger.client.rpc("platform_support_threads")).error.code, "42501");

  // Главный админ видит обращение и непрочитанное.
  const threads = (await boss.rpc("platform_support_threads")).data;
  const thread = threads.find((t) => t.workspace_id === owner.workspace);
  assert.equal(thread.name, "Школа с вопросом");
  assert.equal(thread.last_text, "Прошу продлить доступ");
  assert.equal(thread.unread, 1);
  assert.ok((await boss.rpc("support_unread", { p_as_platform: true })).data >= 1);

  await boss.rpc("support_mark_read", { p_workspace: owner.workspace, p_as_platform: true });
  assert.equal((await boss.rpc("platform_support_threads")).data.find((t) => t.workspace_id === owner.workspace).unread, 0);

  // Ответ доходит до владельца.
  assert.equal((await send(boss, "Продлил", true)).error, null);
  assert.equal((await owner.client.rpc("support_unread")).data, 1);
  const { data: seen } = await owner.client.from("support_messages").select("sender, text, author_email").order("created_at");
  assert.deepEqual(seen.map((m) => m.sender), ["owner", "platform"]);
  assert.ok(seen[0].author_email === owner.email);
  await owner.client.rpc("support_mark_read", { p_workspace: owner.workspace });
  assert.equal((await owner.client.rpc("support_unread")).data, 0);

  // Срок истёк: кабинет закрыт, а поддержка работает, иначе нельзя попросить продление.
  await invoke(boss, "platform", { action: "set_access", workspace_id: owner.workspace, until: new Date(Date.now() - 86400000).toISOString() });
  assert.deepEqual((await owner.client.from("leads").select("id")).data, []);
  assert.equal((await send(owner.client, "Срок закончился, продлите")).error, null);
  assert.equal((await owner.client.from("support_messages").select("id")).data.length, 3);
  assert.match((await send(staff, "Я сотрудник")).error.message, /только владелец/);

  // Продление из чата возвращает новую дату.
  const extended = await invoke(boss, "platform", { action: "set_access", workspace_id: owner.workspace, add_months: 1 });
  assert.ok(new Date(extended.access_until) > new Date(Date.now() + 27 * 86400000));
  assert.equal((await owner.client.rpc("my_access")).data.memberships[0].active, true);

  // Пустое сообщение и прямая запись в таблицу не проходят.
  assert.match((await send(owner.client, "   ")).error.message, /до 4000/);
  assert.ok((await owner.client.from("support_messages").insert({ workspace_id: owner.workspace, sender: "platform", text: "Подделка" })).error);
  assert.ok((await owner.client.from("support_messages").delete().eq("workspace_id", owner.workspace)).error);
});

test("Продление компании доходит до владельца, личные сроки сотрудников не трогает без команды", async () => {
  const owner = await newOwner("Школа со сроком");
  const staffEmail = `term-staff${Date.now()}@example.com`;
  const added = await invoke(boss, "platform", { action: "add_user", workspace_id: owner.workspace, email: staffEmail, password: "password123", role: "admin", until: new Date(Date.now() + 10 * 86400000).toISOString() });
  const { client: staff } = await login(staffEmail, "password123");
  const shown = async (client) => (await client.rpc("my_access")).data.memberships[0];

  await invoke(boss, "platform", { action: "set_access", workspace_id: owner.workspace, until: new Date(Date.now() + 20 * 86400000).toISOString() });
  await invoke(boss, "platform", { action: "set_user_access", workspace_id: owner.workspace, user_id: owner.user.id, until: new Date(Date.now() + 5 * 86400000).toISOString() });
  const daysOf = (row) => Math.round((new Date(row.access_until) - Date.now()) / 86400000);
  assert.equal(daysOf(await shown(owner.client)), 5, "личный срок владельца меньше срока компании");

  // Ошибочное продление ничего не меняет.
  assert.equal((await invoke(boss, "platform", { action: "set_access", workspace_id: owner.workspace, add_months: 0 })).status, 400);
  assert.equal((await invoke(boss, "platform", { action: "set_access", workspace_id: owner.workspace, until: "не дата" })).status, 400);
  assert.equal(daysOf(await shown(owner.client)), 5);

  // Главный админ продлевает: владелец сразу видит новый срок компании.
  const { access_until: extended } = await invoke(boss, "platform", { action: "set_access", workspace_id: owner.workspace, add_months: 1 });
  const ownerNow = await shown(owner.client);
  assert.equal(new Date(ownerNow.access_until).getTime(), new Date(extended).getTime());
  assert.ok(daysOf(ownerNow) > 45);

  // Личный срок сотрудника остаётся, пока его не снимут.
  assert.equal(daysOf(await shown(staff)), 10);
  assert.equal((await invoke(boss, "platform", { action: "clear_user_terms", workspace_id: owner.workspace })).ok, true);
  assert.equal(new Date((await shown(staff)).access_until).getTime(), new Date(extended).getTime());
  const { companies } = await invoke(boss, "platform", { action: "overview" });
  assert.ok(companies.find((c) => c.id === owner.workspace).members.every((m) => m.access_until === null));
  assert.equal(added.user_id.length > 0, true);
  assert.equal((await invoke(owner.client, "platform", { action: "clear_user_terms", workspace_id: owner.workspace })).status, 403);
});

async function clientOnLesson(owner, chatId, minutes, platform = "telegram") {
  const { data: channel } = await owner.client.from("channels").select("id").eq("platform", platform).is("deleted_at", null).single();
  const { data: contact } = await owner.client.from("contacts").select("id").eq("external_id", chatId).single();
  const { data: lesson } = await owner.client.from("lessons").insert({
    workspace_id: owner.workspace, title: "Английский A1", starts_at: new Date(Date.now() + minutes * 60000).toISOString(),
  }).select().single();
  const { data: student, error } = await owner.client.from("lesson_students").insert({
    workspace_id: owner.workspace, lesson_id: lesson.id, contact_id: contact.id, name: "Анна",
  }).select().single();
  assert.equal(error, null);
  return { channel, lesson, student };
}
const cron = (name) => fetch(fn(name), { method: "POST", headers: { "x-cron-secret": CRON_SECRET } });

test("Напоминание об уроке доходит через бота, видно в переписке и в уроке, ошибка клиента не ломает канал", async () => {
  const owner = await newOwner();
  const res = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "telegram", token: "111:TOKEN" });
  const secret = (await secretOf(res.channel.id)).webhook_secret;
  const say = (chatId, text, id) => fetch(fn("webhook", `/${res.channel.id}`), {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({ update_id: id, message: { message_id: id, chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "Анна" }, text } }),
  });
  await say(5551, "Привет", 1);
  await say(5552, "Привет", 2);

  assert.equal((await fetch(fn("reminders"), { method: "POST" })).status, 401);
  assert.equal((await fetch(fn("reminders"), { method: "POST", headers: { "x-cron-secret": "wrong" } })).status, 401);

  const { student } = await clientOnLesson(owner, "5551", 600);
  const blocked = await clientOnLesson(owner, "5552", 45);
  await mock.reset();
  await mock.fail("sendMessage", 403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
  await cron("reminders");
  await mock.reset();

  const { data: failed } = await owner.client.from("lesson_reminders").select("kind, error, messages(status, error)").eq("student_id", blocked.student.id).single();
  assert.equal(failed.kind, "hour");
  assert.equal(failed.messages.status, "failed");
  assert.match(failed.messages.error, /заблокировал бота/);
  const { data: healthy } = await owner.client.from("channels").select("last_error").single();
  assert.equal(healthy.last_error, null, "блокировка одним клиентом не значит, что канал сломан");

  // Второй запуск ничего не отправляет повторно.
  assert.equal((await (await cron("reminders")).json()).sent, 0);
  assert.equal((await sent("telegram", "sendMessage")).length, 0);

  // Успешная доставка.
  const fresh = await clientOnLesson(owner, "5551", 30);
  assert.equal((await (await cron("reminders")).json()).sent, 1);
  const out = await sent("telegram", "sendMessage");
  assert.equal(out.length, 1);
  assert.equal(String(out[0].body.chat_id), "5551");
  assert.match(out[0].body.text, /^Скоро начало: /);
  assert.match(out[0].body.text, /Английский A1/);
  const { data: delivered } = await owner.client.from("lesson_reminders").select("messages(status, sender, text)").eq("student_id", fresh.student.id).single();
  assert.equal(delivered.messages.status, "sent");
  assert.equal(delivered.messages.sender, "bot");
  assert.ok(student.id);
});

test("Проверка каналов: отозванный токен виден владельцу, сбой сети тревогу не поднимает, починка её снимает", async () => {
  const owner = await newOwner();
  await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "telegram", token: "111:TOKEN" });
  const row = async () => (await owner.client.from("channels").select("last_error").single()).data.last_error;

  assert.equal((await (await cron("refresh-tokens")).json()).broken, 0);
  assert.equal(await row(), null);

  // Telegram сам временно недоступен: это не поломка токена.
  await mock.fail("getMe", 500, { ok: false, description: "Internal Server Error" });
  assert.equal((await (await cron("refresh-tokens")).json()).broken, 0);
  assert.equal(await row(), null);

  await mock.reset();
  await mock.fail("getMe", 401, { ok: false, error_code: 401, description: "Unauthorized" });
  assert.equal((await (await cron("refresh-tokens")).json()).broken, 1);
  assert.match(await row(), /^Проверка токена не прошла: Telegram не принял токен/);

  await mock.reset();
  await cron("refresh-tokens");
  assert.equal(await row(), null, "токен снова работает, тревога снята");

  // Чужую ошибку (например, отправки) проверка токена не стирает.
  await stack.db.query("update channels set last_error = 'Ошибка отправки' where workspace_id = $1", [owner.workspace]);
  await cron("refresh-tokens");
  assert.equal(await row(), "Ошибка отправки");
});

test("Продление токена Instagram: сбой виден владельцу, следующая удачная попытка его снимает", async () => {
  const owner = await newOwner();
  const res = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "instagram", token: "IG-OLD", app_secret: "s" });
  await stack.db.query("update channels set token_expires_at = now() + interval '5 days', last_error = null where id = $1", [res.channel.id]);

  await mock.fail("refresh_access_token", 400, { error: { code: 190, message: "expired" } });
  await cron("refresh-tokens");
  const { data: failed } = await owner.client.from("channels").select("last_error, token_hint").single();
  assert.match(failed.last_error, /^Не удалось продлить токен: Токен недействителен/);
  assert.equal(failed.token_hint, "••••-OLD");

  await mock.reset();
  await cron("refresh-tokens");
  const { data: fixed } = await owner.client.from("channels").select("last_error, token_hint, token_expires_at").single();
  assert.equal(fixed.last_error, null);
  assert.equal(fixed.token_hint, "••••9999");
  assert.ok(new Date(fixed.token_expires_at) > new Date(Date.now() + 50 * 86400000));
});

test("Instagram: токен Facebook (Unified login) находит аккаунт, пишет через graph.facebook.com и не требует продления", async () => {
  const owner = await newOwner();
  await addQuestions(owner, [{ type: "text", text: "Как вас зовут?" }]);

  const noAccount = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "instagram", token: "EAA-USER-NO-IG", app_secret: "s" });
  assert.match(noAccount.error, /нет доступа к аккаунту Instagram/);
  assert.match(noAccount.error, /Ответ Meta: assigned: .*app: Qabul.*debug: USER.*pages: 0/, "в ошибке видно, что ответила Meta");

  // Владелец сам указал id аккаунта, а профиль по нему Meta не отдаёт.
  const manual = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "instagram", token: "EAA-USER-NO-IG", app_secret: "s", account_id: "17841400000000005" });
  assert.equal(manual.channel.external_id, "17841400000000005");
  assert.equal(manual.channel.name, "Instagram");
  const wrong = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "instagram", token: "EAA-USER-NO-IG", app_secret: "s", account_id: "17841400000000099" });
  assert.match(wrong.error, /не даёт этому токену доступ к аккаунту 17841400000000099/);

  // Аккаунт известен только самому токену (granular_scopes), а по id Meta его не отдаёт.
  const granular = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "instagram", token: "EAA-GRANULAR-TOKEN", app_secret: "s" });
  assert.equal(granular.channel.external_id, "17841400000000004");
  assert.equal(granular.channel.name, "Instagram");
  assert.equal((await sent("facebook", "17841400000000004/subscribed_apps")).length, 1);

  const APP_SECRET = "fb-app-secret";
  const res = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "instagram", token: "EAA-UNIFIED-TOKEN", app_secret: APP_SECRET });
  assert.equal(res.channel.external_id, "17841400000000002");
  assert.equal(res.channel.name, "@school_unified");
  assert.equal(res.channel.token_expires_at, null, "токен Unified login не истекает");
  const [subscribe] = await sent("facebook", "17841400000000002/subscribed_apps");
  assert.equal(subscribe.query.subscribed_fields, "messages,messaging_postbacks");

  // Токен страницы Facebook тоже подходит.
  const page = await invoke(owner.client, "channels", { action: "connect", workspace_id: owner.workspace, platform: "instagram", token: "EAA-PAGE-TOKEN", app_secret: APP_SECRET });
  assert.equal(page.channel.external_id, "17841400000000003");
  assert.equal(page.channel.name, "@school_page");

  const secret = await secretOf(res.channel.id);
  const body = JSON.stringify({ object: "instagram", entry: [{ id: "17841400000000002", time: 1, messaging: [{ sender: { id: "u-901" }, recipient: { id: "17841400000000002" }, timestamp: 1, message: { mid: "m-u1", text: "Привет" } }] }] });
  const sig = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");
  const r = await fetch(fn("webhook", "/meta"), { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body });
  assert.equal(r.status, 200);
  const out = await sent("facebook", "17841400000000002/messages");
  assert.equal(out.length, 2, "приветствие и вопрос ушли через graph.facebook.com от имени аккаунта Instagram");
  assert.equal(out[1].body.recipient.id, "u-901");
  assert.match(out[1].body.message.text, /Как вас зовут/);
  assert.equal((await sent("instagram", "me/messages")).length, 0);
  assert.equal(secret.webhook_secret.length > 0, true);

  // Ежечасная проверка такой токен принимает и срок ему не ставит.
  await cron("refresh-tokens");
  const { data: rows } = await owner.client.from("channels").select("last_error, token_expires_at").eq("id", res.channel.id).single();
  assert.deepEqual(rows, { last_error: null, token_expires_at: null });
});
