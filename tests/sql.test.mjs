// Логика бота, RLS и права на настоящем Postgres.
// Запуск: tests/stack/pg.sh start && node --test tests/sql.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const db = new pg.Pool({
  connectionString: process.env.CRM_PG_URL ?? "postgres://postgres@127.0.0.1:54329/postgres",
  max: 12,
});
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => (await q(sql, args))[0];
let seq = 0;
const uid = (name) => `${name}-${Date.now()}-${++seq}`;

async function signup(meta = {}, appMeta = {}) {
  const email = `${uid("u")}@example.com`;
  const user = await one(
    "insert into auth.users (email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3) returning *",
    [email, meta, appMeta],
  );
  const member = await one("select * from workspace_members where user_id = $1", [user.id]);
  return { id: user.id, email, workspace: member?.workspace_id, role: member?.role };
}

// Сотрудника добавляет функция team или platform: отдельная запись о членстве.
async function staff(workspace) {
  const user = await signup();
  await q("insert into workspace_members (workspace_id, user_id, role, email) values ($1, $2, 'admin', $3)", [workspace, user.id, user.email]);
  return { ...user, workspace, role: "admin" };
}

// Компанию с владельцем создаёт главный админ, регистрации больше нет.
async function company(name = "Школа", accessUntil = null) {
  const owner = await signup();
  const { workspace } = await one(
    "select platform_create_company($1, $2, $3, $4) as workspace", [name, owner.id, owner.email, accessUntil]);
  return { ...owner, workspace, role: "owner" };
}

// Выполняет запрос от имени роли так же, как PostgREST: role + jwt claims в транзакции.
async function as(role, userId, fn) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(userId ? { sub: userId, role } : { role }),
    ]);
    const result = await fn((sql, args = []) => client.query(sql, args).then((r) => r.rows));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function channel(workspace, platform = "telegram") {
  return one(
    "insert into channels (workspace_id, platform, name, external_id) values ($1, $2, 'Канал', $3) returning *",
    [workspace, platform, uid("ext")],
  );
}

async function defaultSurvey(workspace) {
  return one("select * from surveys where workspace_id = $1 and is_default", [workspace]);
}

const OPTIONS = [
  { id: "sat", label: "Суббота" },
  { id: "sun", label: "Воскресенье" },
];

async function addQuestions(survey) {
  const rows = [];
  rows.push(await one(
    "insert into questions (survey_id, position, type, text, options) values ($1, 1, 'choice', 'Когда удобно?', $2) returning *",
    [survey, JSON.stringify(OPTIONS)],
  ));
  rows.push(await one("insert into questions (survey_id, position, type, text) values ($1, 2, 'text', 'Как вас зовут?') returning *", [survey]));
  rows.push(await one("insert into questions (survey_id, position, type, text) values ($1, 3, 'phone', 'Ваш телефон?') returning *", [survey]));
  rows.push(await one("insert into questions (survey_id, position, type, text, required) values ($1, 4, 'text', 'Пожелания?', false) returning *", [survey]));
  return rows;
}

async function inbound(channelId, user, { text = null, option = null, id = uid("m"), attachment = null, meta = {} } = {}) {
  const row = await one(
    `select bot_handle_inbound($1, $2, $3, $4, $5, 'Клиент', null, $6, $7) as r`,
    [channelId, user, id, text, option, meta, attachment],
  );
  return row.r;
}

async function setup() {
  const owner = await company("Школа");
  const survey = await defaultSurvey(owner.workspace);
  const questions = await addQuestions(survey.id);
  const ch = await channel(owner.workspace);
  return { owner, survey, questions, ch };
}

const texts = (result) => result.outbound.map((m) => m.text);

after(() => db.end());

test("создание компании даёт владельца и основной опрос без вопросов", async () => {
  const user = await company("Школа №1");
  assert.equal(user.role, "owner");
  assert.equal((await one("select name from workspaces where id = $1", [user.workspace])).name, "Школа №1");
  const survey = await defaultSurvey(user.workspace);
  assert.ok(survey);
  assert.equal((await q("select 1 from questions where survey_id = $1", [survey.id])).length, 0);
});

test("новый пользователь без приглашения не получает кабинет", async () => {
  const user = await signup({ company: "Сам себе компания" });
  assert.equal(user.workspace, undefined);
  assert.equal((await q("select 1 from workspaces where owner_id = $1", [user.id])).length, 0);
});

test("создание пользователя от роли supabase_auth_admin работает, как на настоящем Supabase", async () => {
  const email = `${uid("gotrue")}@example.com`;
  const client = await db.connect();
  try {
    await client.query("set role supabase_auth_admin");
    await client.query("insert into auth.users (email) values ($1)", [email]);
  } finally {
    await client.query("reset role");
    client.release();
  }
  assert.equal((await q("select 1 from auth.users where email = $1", [email])).length, 1);
});

test("приглашение из user_metadata не даёт войти в чужой кабинет", async () => {
  const victim = await company();
  const attacker = await signup({ invited_workspace: victim.workspace });
  assert.equal(attacker.workspace, undefined);
});

test("метаданные пользователя не дают входа в чужой кабинет", async () => {
  const victim = await company();
  const viaApp = await signup({}, { invited_workspace: victim.workspace });
  assert.equal(viaApp.workspace, undefined);
});

test("удаление учётной записи владельца не удаляет компанию", async () => {
  const { owner, ch } = await setup();
  const start = await inbound(ch.id, "keep", { text: "hi" });
  await q("delete from auth.users where id = $1", [owner.id]);
  assert.equal((await one("select owner_id from workspaces where id = $1", [owner.workspace])).owner_id, null);
  assert.equal((await q("select 1 from leads where id = $1", [start.lead_id])).length, 1);
});

test("полный опрос: кнопка, номер варианта, текст, телефон, пропуск", async () => {
  const { ch } = await setup();
  const first = await inbound(ch.id, "client1", { text: "привет" });
  assert.deepEqual(texts(first)[1], "Когда удобно?");
  assert.equal(first.outbound.length, 2);
  assert.deepEqual(first.outbound[1].options, OPTIONS);
  assert.equal(first.new_contact, true);

  const second = await inbound(ch.id, "client1", { option: "sun" });
  assert.deepEqual(texts(second), ["Как вас зовут?"]);
  assert.equal(second.new_contact, false);

  // В текстовом вопросе цифра остаётся ответом.
  const third = await inbound(ch.id, "client1", { text: "1" });
  assert.deepEqual(texts(third), ["Ваш телефон?"]);

  const badPhone = await inbound(ch.id, "client1", { text: "не скажу" });
  assert.match(texts(badPhone)[0], /ошибка/);
  assert.match(texts(badPhone)[0], /Ваш телефон\?/);

  const fourth = await inbound(ch.id, "client1", { text: "+998 (90) 123-45-67" });
  assert.equal(texts(fourth)[0], "Пожелания?");
  assert.deepEqual(fourth.outbound[0].options, [{ id: "skip", label: "Пропустить" }]);

  const done = await inbound(ch.id, "client1", { text: "пропустить" });
  assert.match(texts(done)[0], /Спасибо/);

  const lead = await one("select * from leads where id = $1", [first.lead_id]);
  assert.equal(lead.status, "new");
  assert.equal(lead.current_question_id, null);
  assert.ok(lead.completed_at);

  const answers = await q("select question_text, answer_text from answers where lead_id = $1 order by position", [lead.id]);
  assert.deepEqual(answers.map((a) => a.answer_text), ["Воскресенье", "1", "+998901234567", null]);

  const contact = await one("select phone from contacts where id = $1", [lead.contact_id]);
  assert.equal(contact.phone, "+998901234567");

  const stored = await q("select text from messages where lead_id = $1 and direction = 'in' order by created_at", [lead.id]);
  assert.ok(stored.map((m) => m.text).includes("Воскресенье"), "текст кнопки сохранён в переписке");
});

test("выбор по номеру и по тексту варианта, регистр не важен", async () => {
  const { ch } = await setup();
  await inbound(ch.id, "n1", { text: "hi" });
  assert.deepEqual(texts(await inbound(ch.id, "n1", { text: "2." })), ["Как вас зовут?"]);
  await inbound(ch.id, "n2", { text: "hi" });
  assert.deepEqual(texts(await inbound(ch.id, "n2", { text: "суББота" })), ["Как вас зовут?"]);
  const answers = await q(
    `select a.option_id from answers a join leads l on l.id = a.lead_id join contacts c on c.id = l.contact_id
     where c.channel_id = $1 order by c.external_id`, [ch.id]);
  assert.deepEqual(answers.map((a) => a.option_id), ["sun", "sat"]);
});

test("свой вариант принимается только при allow_other", async () => {
  const { ch, questions } = await setup();
  await inbound(ch.id, "o1", { text: "hi" });
  const rejected = await inbound(ch.id, "o1", { text: "В понедельник" });
  assert.match(texts(rejected)[0], /Выберите один из вариантов/);

  await q("update questions set allow_other = true where id = $1", [questions[0].id]);
  const accepted = await inbound(ch.id, "o1", { text: "В понедельник" });
  assert.deepEqual(texts(accepted), ["Как вас зовут?"]);
  const answer = await one("select a.answer_text from answers a where a.lead_id = $1", [accepted.lead_id]);
  assert.equal(answer.answer_text, "В понедельник");
});

test("устаревшая кнопка не засчитывается как ответ", async () => {
  const { ch } = await setup();
  await inbound(ch.id, "s1", { text: "hi" });
  await inbound(ch.id, "s1", { option: "sat" });
  const stale = await inbound(ch.id, "s1", { option: "sun" });
  assert.match(texts(stale)[0], /Напишите ответ текстом/);
  const count = await one("select count(*)::int as c from answers where lead_id = $1", [stale.lead_id]);
  assert.equal(count.c, 1);
});

test("повторная доставка webhook не дублирует сообщение и ответ", async () => {
  const { ch } = await setup();
  await inbound(ch.id, "d1", { text: "hi", id: "same-0" });
  const first = await inbound(ch.id, "d1", { option: "sat", id: "same-1" });
  const again = await inbound(ch.id, "d1", { option: "sat", id: "same-1" });
  assert.equal(again.duplicate, true);
  const msgs = await one("select count(*)::int as c from messages where lead_id = $1 and direction = 'in'", [first.lead_id]);
  assert.equal(msgs.c, 2);
});

test("10 параллельных сообщений нового клиента дают одну заявку и не ломают опрос", async () => {
  const { ch } = await setup();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => inbound(ch.id, "race", { text: `сообщение ${i}` })),
  );
  const leads = await q(
    "select l.id from leads l join contacts c on c.id = l.contact_id where c.channel_id = $1 and c.external_id = 'race'", [ch.id]);
  assert.equal(leads.length, 1);
  assert.equal(new Set(results.map((r) => r.lead_id)).size, 1);
  const inMsgs = await one("select count(*)::int as c from messages where lead_id = $1 and direction = 'in'", [leads[0].id]);
  assert.equal(inMsgs.c, 10);
  // Опрос либо ждёт варианта, либо передан человеку после трёх ошибок, но не застрял в неверном состоянии.
  const lead = await one("select status, handoff from leads where id = $1", [leads[0].id]);
  assert.ok(["collecting", "new"].includes(lead.status));
  if (lead.status === "new") assert.equal(lead.handoff, true);
});

test("/start повторяет вопрос и не считается ошибкой", async () => {
  const { ch } = await setup();
  await inbound(ch.id, "st", { text: "/start" });
  const again = await inbound(ch.id, "st", { text: "/start" });
  assert.deepEqual(texts(again), ["Когда удобно?"]);
  const lead = await one("select invalid_attempts from leads where id = $1", [again.lead_id]);
  assert.equal(lead.invalid_attempts, 0);
});

test("вложение вместо ответа сохраняется и бот просит текст", async () => {
  const { ch } = await setup();
  await inbound(ch.id, "at", { text: "hi" });
  const r = await inbound(ch.id, "at", { attachment: "фото" });
  assert.match(texts(r)[0], /понимаю только текст/);
  const msg = await one("select attachment from messages where lead_id = $1 and attachment is not null", [r.lead_id]);
  assert.equal(msg.attachment, "фото");
});

test("три ошибки подряд и слово «оператор» передают заявку человеку", async () => {
  const { ch } = await setup();
  await inbound(ch.id, "h1", { text: "hi" });
  await inbound(ch.id, "h1", { text: "нет" });
  await inbound(ch.id, "h1", { text: "нет" });
  const third = await inbound(ch.id, "h1", { text: "нет" });
  assert.match(texts(third)[0], /администратору/);
  const lead = await one("select status, handoff from leads where id = $1", [third.lead_id]);
  assert.deepEqual([lead.status, lead.handoff], ["new", true]);

  await inbound(ch.id, "h2", { text: "hi" });
  const op = await inbound(ch.id, "h2", { text: "Оператор" });
  assert.match(texts(op)[0], /администратору/);
  const silent = await inbound(ch.id, "h2", { text: "ау" });
  assert.deepEqual(silent.outbound, []);
});

test("после завершения опроса бот молчит, а сообщения копятся как непрочитанные", async () => {
  const { ch, questions } = await setup();
  await q("delete from questions where id = any($1)", [questions.slice(1).map((x) => x.id)]);
  await inbound(ch.id, "q1", { text: "hi" });
  const done = await inbound(ch.id, "q1", { option: "sat" });
  await q("update leads set unread_count = 0 where id = $1", [done.lead_id]);
  const extra = await inbound(ch.id, "q1", { text: "Ещё вопрос" });
  assert.deepEqual(extra.outbound, []);
  assert.equal(extra.lead_id, done.lead_id);
  const lead = await one("select unread_count, last_message_preview from leads where id = $1", [done.lead_id]);
  assert.equal(lead.unread_count, 1);
  assert.equal(lead.last_message_preview, "Ещё вопрос");
});

test("опрос без вопросов сразу создаёт заявку и бот молчит", async () => {
  const owner = await company();
  const ch = await channel(owner.workspace);
  const r = await inbound(ch.id, "e1", { text: "hi" });
  assert.deepEqual(r.outbound, []);
  assert.equal((await one("select status from leads where id = $1", [r.lead_id])).status, "new");
});

test("удаление вопроса во время прохождения не ломает опрос", async () => {
  const { ch, questions } = await setup();
  await inbound(ch.id, "del", { text: "hi" });
  await q("delete from questions where id = $1", [questions[0].id]);
  const r = await inbound(ch.id, "del", { text: "Анна" });
  // Текущий вопрос исчез: ответ относится к следующему по порядку.
  assert.deepEqual(texts(r), ["Ваш телефон?"]);
});

test("закрытая заявка: в течение суток возобновляется, позже стартует новый опрос", async () => {
  const { owner, ch, questions } = await setup();
  await q("delete from questions where id = any($1)", [questions.slice(1).map((x) => x.id)]);
  await inbound(ch.id, "c1", { text: "hi" });
  const done = await inbound(ch.id, "c1", { option: "sat" });

  await as("authenticated", owner.id, (run) => run("select set_lead_status($1, 'done')", [done.lead_id]));
  assert.ok((await one("select closed_at from leads where id = $1", [done.lead_id])).closed_at);

  const thanks = await inbound(ch.id, "c1", { text: "Спасибо" });
  assert.equal(thanks.lead_id, done.lead_id);
  assert.deepEqual(thanks.outbound, []);
  assert.equal((await one("select status from leads where id = $1", [done.lead_id])).status, "new");

  await as("authenticated", owner.id, (run) => run("select set_lead_status($1, 'done')", [done.lead_id]));
  await q("update leads set closed_at = now() - interval '25 hours' where id = $1", [done.lead_id]);
  const fresh = await inbound(ch.id, "c1", { text: "Здравствуйте снова" });
  assert.notEqual(fresh.lead_id, done.lead_id);
  assert.equal(fresh.outbound.at(-1).text, "Когда удобно?");
});

test("взять в работу: бот замолкает, второй администратор получает отказ", async () => {
  const { owner, ch } = await setup();
  const admin = await staff(owner.workspace);
  const start = await inbound(ch.id, "t1", { text: "hi" });

  await as("authenticated", owner.id, (run) => run("select take_lead($1)", [start.lead_id]));
  const lead = await one("select status, assigned_to, unread_count, current_question_id from leads where id = $1", [start.lead_id]);
  assert.equal(lead.status, "in_work");
  assert.equal(lead.assigned_to, owner.id);
  assert.equal(lead.unread_count, 0);
  assert.equal(lead.current_question_id, null);

  await assert.rejects(
    as("authenticated", admin.id, (run) => run("select take_lead($1)", [start.lead_id])),
    /уже взял в работу/,
  );
  const silent = await inbound(ch.id, "t1", { option: "sat" });
  assert.deepEqual(silent.outbound, []);
});

test("ответ администратора закрепляет заявку и останавливает опрос", async () => {
  const { owner, ch } = await setup();
  const start = await inbound(ch.id, "ag", { text: "hi", meta: { bc: "conn1" } });
  const queued = await one("select agent_queue_message($1, $2, 'Здравствуйте!') as r", [start.lead_id, owner.id]);
  assert.equal(queued.r.contact_external_id, "ag");
  assert.equal(queued.r.contact_meta.bc, "conn1");
  const lead = await one("select status, assigned_to from leads where id = $1", [start.lead_id]);
  assert.deepEqual([lead.status, lead.assigned_to], ["in_work", owner.id]);

  await one("select bot_message_result($1, 'ext-1', null)", [queued.r.message_id]);
  assert.equal((await one("select status from messages where id = $1", [queued.r.message_id])).status, "sent");

  const failed = await one("select agent_queue_message($1, $2, 'Ещё') as r", [start.lead_id, owner.id]);
  await one("select bot_message_result($1, null, 'Окно 24 часа закрыто')", [failed.r.message_id]);
  assert.equal((await one("select last_error from channels where id = $1", [ch.id])).last_error, null, "ошибка одного клиента не красит весь канал");
  const row = await one("select status, error from messages where id = $1", [failed.r.message_id]);
  assert.deepEqual([row.status, row.error], ["failed", "Окно 24 часа закрыто"]);

  const tokenFail = await one("select agent_queue_message($1, $2, 'Третье') as r", [start.lead_id, owner.id]);
  await one("select bot_message_result($1, null, 'Токен истёк', true)", [tokenFail.r.message_id]);
  assert.equal((await one("select last_error from channels where id = $1", [ch.id])).last_error, "Токен истёк");
  const recovered = await one("select agent_queue_message($1, $2, 'Четвёртое') as r", [start.lead_id, owner.id]);
  await one("select bot_message_result($1, 'ext-4')", [recovered.r.message_id]);
  assert.equal((await one("select last_error from channels where id = $1", [ch.id])).last_error, null);
});

test("чужой администратор не может отправить сообщение в заявку", async () => {
  const { ch } = await setup();
  const stranger = await company();
  const start = await inbound(ch.id, "x1", { text: "hi" });
  await assert.rejects(q("select agent_queue_message($1, $2, 'спам')", [start.lead_id, stranger.id]), /не найдена/);
});

test("сообщение владельца из Telegram останавливает бота и попадает в переписку", async () => {
  const { ch } = await setup();
  const start = await inbound(ch.id, "ow", { text: "hi" });
  const r = await one("select bot_record_owner_message($1, 'ow', 'own-1', 'Добрый день, это Анна') as r", [ch.id]);
  assert.equal(r.r.lead_id, start.lead_id);
  assert.equal((await one("select status from leads where id = $1", [start.lead_id])).status, "in_work");
  const silent = await inbound(ch.id, "ow", { option: "sat" });
  assert.deepEqual(silent.outbound, []);
  const unknown = await one("select bot_record_owner_message($1, 'never', 'own-2', 'привет') as r", [ch.id]);
  assert.equal(unknown.r.ignored, true);
});

test("выключенный и удалённый каналы игнорируют сообщения", async () => {
  const { ch } = await setup();
  await q("update channels set is_active = false where id = $1", [ch.id]);
  assert.equal((await inbound(ch.id, "off", { text: "hi" })).ignored, true);
  await q("update channels set is_active = true, deleted_at = now() where id = $1", [ch.id]);
  assert.equal((await inbound(ch.id, "off", { text: "hi" })).ignored, true);
});

test("канал использует назначенный опрос, а не основной", async () => {
  const { owner, ch } = await setup();
  const other = await one(
    "insert into surveys (workspace_id, name, welcome_text) values ($1, 'Другой', null) returning *", [owner.workspace]);
  await q("insert into questions (survey_id, position, type, text) values ($1, 1, 'text', 'Вопрос другого опроса')", [other.id]);
  await q("update channels set survey_id = $1 where id = $2", [other.id, ch.id]);
  const r = await inbound(ch.id, "sv", { text: "hi" });
  assert.deepEqual(texts(r), ["Вопрос другого опроса"]);
});

test("RLS: чужой кабинет не виден ни в одной таблице", async () => {
  const { ch, owner, survey } = await setup();
  const r = await inbound(ch.id, "rls", { text: "hi" });
  await inbound(ch.id, "rls", { option: "sat" });
  const stranger = await company();
  const tables = ["workspaces", "workspace_members", "surveys", "questions", "channels", "contacts", "leads", "answers", "messages"];

  for (const table of tables) {
    const mine = await as("authenticated", owner.id, (run) => run(`select * from ${table}`));
    assert.ok(mine.length > 0, `владелец видит ${table}`);
    const theirs = await as("authenticated", stranger.id, (run) => run(`select * from ${table}`));
    const leaked = theirs.filter((row) =>
      row.workspace_id === owner.workspace || row.id === owner.workspace || row.survey_id === survey.id);
    assert.equal(leaked.length, 0, `утечка в ${table}`);
    await assert.rejects(as("anon", null, (run) => run(`select * from ${table}`)), /permission denied/, `anon в ${table}`);
  }

  await as("authenticated", stranger.id, async (run) => {
    await run("select take_lead($1)", [r.lead_id]).then(
      () => assert.fail("чужой взял заявку"),
      (e) => assert.match(e.message, /не найдена/),
    );
  }).catch((e) => assert.match(e.message, /не найдена|aborted/));
  await as("authenticated", stranger.id, (run) => run("select set_lead_note($1, 'взлом')", [r.lead_id]));
  assert.equal((await one("select note from leads where id = $1", [r.lead_id])).note, null);
  await as("authenticated", stranger.id, (run) => run("select mark_lead_read($1)", [r.lead_id]));
  assert.ok((await one("select unread_count from leads where id = $1", [r.lead_id])).unread_count > 0);
});

test("токены недоступны браузеру даже владельцу", async () => {
  const { owner, ch } = await setup();
  await q("insert into channel_secrets (channel_id, token_enc, webhook_secret) values ($1, 'enc', 'sec')", [ch.id]);
  await assert.rejects(as("authenticated", owner.id, (run) => run("select * from channel_secrets")), /permission denied/);
  await assert.rejects(as("anon", null, (run) => run("select * from channel_secrets")), /permission denied/);
  const viaService = await as("service_role", null, (run) => run("select * from channel_secrets where channel_id = $1", [ch.id]));
  assert.equal(viaService.length, 1);
});

test("функции бота закрыты для браузера и открыты для service_role", async () => {
  const { owner, ch } = await setup();
  const calls = [
    ["select bot_handle_inbound($1, 'x', 'y')", [ch.id]],
    ["select bot_record_owner_message($1, 'x', 'y', 'z')", [ch.id]],
    ["select bot_message_result(gen_random_uuid())", []],
    ["select agent_queue_message(gen_random_uuid(), gen_random_uuid(), 'z')", []],
  ];
  for (const [sql, args] of calls) {
    await assert.rejects(as("authenticated", owner.id, (run) => run(sql, args)), /permission denied/);
    await assert.rejects(as("anon", null, (run) => run(sql, args)), /permission denied/);
  }
  await as("service_role", null, (run) => run("select bot_handle_inbound($1, 'svc', 'svc-1', 'hi')", [ch.id]));
  for (const fn of ["take_lead(gen_random_uuid())", "mark_lead_read(gen_random_uuid())"]) {
    await assert.rejects(as("anon", null, (run) => run(`select ${fn}`)), /permission denied/);
  }
});

test("браузер не может менять заявки, токены канала и чужие поля напрямую", async () => {
  const { owner, ch } = await setup();
  const r = await inbound(ch.id, "dm", { text: "hi" });
  await assert.rejects(as("authenticated", owner.id, (run) => run("update leads set status = 'done' where id = $1", [r.lead_id])), /permission denied/);
  await assert.rejects(as("authenticated", owner.id, (run) => run("delete from messages where lead_id = $1", [r.lead_id])), /permission denied/);
  await assert.rejects(as("authenticated", owner.id, (run) => run("update channels set external_id = 'x' where id = $1", [ch.id])), /permission denied/);
  await assert.rejects(as("authenticated", owner.id, (run) => run("update workspaces set owner_id = gen_random_uuid() where id = $1", [owner.workspace])), /permission denied/);
  await assert.rejects(as("authenticated", owner.id, (run) => run("insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [owner.workspace, owner.id])), /permission denied/);
});

test("администратор читает опросы, но менять их может только владелец", async () => {
  const { owner, survey, ch } = await setup();
  const admin = await staff(owner.workspace);
  const visible = await as("authenticated", admin.id, (run) => run("select id from questions where survey_id = $1", [survey.id]));
  assert.equal(visible.length, 4);

  await assert.rejects(
    as("authenticated", admin.id, (run) => run("insert into questions (survey_id, text) values ($1, 'x')", [survey.id])),
    /row-level security/,
  );
  const updated = await as("authenticated", admin.id, (run) => run("update surveys set name = 'x' where id = $1 returning id", [survey.id]));
  assert.equal(updated.length, 0);
  const channelUpdated = await as("authenticated", admin.id, (run) => run("update channels set is_active = false where id = $1 returning id", [ch.id]));
  assert.equal(channelUpdated.length, 0);

  const ownerUpdate = await as("authenticated", owner.id, (run) => run("update channels set name = 'Новое' where id = $1 returning id", [ch.id]));
  assert.equal(ownerUpdate.length, 1);
});

test("владелец не может подсунуть вопрос в чужой опрос и привязать чужой опрос к каналу", async () => {
  const a = await setup();
  const b = await setup();
  await assert.rejects(
    as("authenticated", a.owner.id, (run) => run("insert into questions (survey_id, text) values ($1, 'фишинг')", [b.survey.id])),
    /row-level security/,
  );
  await assert.rejects(
    as("authenticated", a.owner.id, (run) => run("update channels set survey_id = $1 where id = $2", [b.survey.id, a.ch.id])),
    /row-level security/,
  );
  const moved = await as("authenticated", a.owner.id, (run) => run("update questions set survey_id = $1 where survey_id = $2 returning id", [b.survey.id, a.survey.id])).catch((e) => e);
  assert.match(String(moved.message), /row-level security/);
});

test("основной опрос можно сменить, а удалить нельзя", async () => {
  const { owner, survey } = await setup();
  const blocked = await as("authenticated", owner.id, (run) => run("delete from surveys where id = $1 returning id", [survey.id]));
  assert.equal(blocked.length, 0);
  const other = await one("insert into surveys (workspace_id, name) values ($1, 'Второй') returning id", [owner.workspace]);
  await as("authenticated", owner.id, (run) => run("select set_default_survey($1)", [other.id]));
  assert.equal((await defaultSurvey(owner.workspace)).id, other.id);
  const stranger = await company();
  await assert.rejects(as("authenticated", stranger.id, (run) => run("select set_default_survey($1)", [survey.id])), /не найден/);
});

test("у одного аккаунта соцсети только один активный канал; после удаления можно подключить заново", async () => {
  const owner = await company();
  const ext = uid("acc");
  const first = await one("insert into channels (workspace_id, platform, name, external_id) values ($1, 'telegram', 'a', $2) returning id", [owner.workspace, ext]);
  await assert.rejects(q("insert into channels (workspace_id, platform, name, external_id) values ($1, 'telegram', 'b', $2)", [owner.workspace, ext]), /channels_account_idx/);
  await q("update channels set deleted_at = now() where id = $1", [first.id]);
  await q("insert into channels (workspace_id, platform, name, external_id) values ($1, 'telegram', 'b', $2)", [owner.workspace, ext]);
});

test("ограничения вопросов: у выбора от 2 до 10 вариантов", async () => {
  const owner = await company();
  const survey = await defaultSurvey(owner.workspace);
  await assert.rejects(q("insert into questions (survey_id, type, text, options) values ($1, 'choice', 'x', $2)", [survey.id, JSON.stringify([{ id: "a", label: "A" }])]), /questions_options_shape/);
  const many = Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, label: `${i}` }));
  await assert.rejects(q("insert into questions (survey_id, type, text, options) values ($1, 'choice', 'x', $2)", [survey.id, JSON.stringify(many)]), /questions_options_shape/);
});

const pastDate = () => new Date(Date.now() - 3600_000).toISOString();
const futureDate = () => new Date(Date.now() + 3600_000).toISOString();

test("истёкший срок компании закрывает данные, действия и бота, продление открывает", async () => {
  const { owner, ch } = await setup();
  const start = await inbound(ch.id, "exp", { text: "hi" });
  assert.equal((await as("authenticated", owner.id, (run) => run("select id from leads"))).length, 1);

  await q("update workspaces set access_until = $1 where id = $2", [pastDate(), owner.workspace]);

  for (const table of ["workspaces", "workspace_members", "surveys", "questions", "channels", "contacts", "leads", "answers", "messages", "lessons"]) {
    assert.equal((await as("authenticated", owner.id, (run) => run(`select * from ${table}`))).length, 0, table);
  }
  await assert.rejects(as("authenticated", owner.id, (run) => run("select take_lead($1)", [start.lead_id])), /не найдена/);
  await assert.rejects(q("select agent_queue_message($1, $2, 'x')", [start.lead_id, owner.id]), /не найдена/);
  assert.equal((await inbound(ch.id, "exp", { option: "sat" })).ignored, true);
  assert.equal((await one("select service_member_role($1, $2) as r", [owner.workspace, owner.id])).r, null);
  await assert.rejects(
    as("authenticated", owner.id, (run) => run("insert into questions (survey_id, text) select id, 'x' from surveys")).then(async (rows) => {
      const n = await one("select count(*)::int as c from questions q join surveys s on s.id = q.survey_id where s.workspace_id = $1 and q.text = 'x'", [owner.workspace]);
      if (n.c === 0) throw new Error("no rows inserted");
    }),
    /no rows inserted/,
  );

  const access = (await as("authenticated", owner.id, (run) => run("select my_access() as a")))[0].a;
  assert.equal(access.memberships[0].active, false);
  assert.equal(access.is_platform_admin, false);

  const extended = await one("select platform_extend_access($1, 3) as d", [owner.workspace]);
  assert.ok(new Date(extended.d) > new Date(Date.now() + 80 * 86400000));
  assert.equal((await as("authenticated", owner.id, (run) => run("select id from leads"))).length, 1);
  assert.deepEqual(texts(await inbound(ch.id, "exp", { option: "sat" })), ["Как вас зовут?"]);
});

test("продление считается от текущего срока, если он ещё не закончился", async () => {
  const owner = await company("Школа", new Date(Date.now() + 40 * 86400000).toISOString());
  const { d } = await one("select platform_extend_access($1, 1) as d", [owner.workspace]);
  assert.ok(new Date(d) > new Date(Date.now() + 65 * 86400000), "40 дней + месяц");
  const unlimited = await company();
  const { d: fromNow } = await one("select platform_extend_access($1, 1) as d", [unlimited.workspace]);
  assert.ok(new Date(fromNow) < new Date(Date.now() + 33 * 86400000));
});

test("приостановка компании и личный срок пользователя тоже закрывают доступ", async () => {
  const { owner, ch } = await setup();
  const admin = await staff(owner.workspace);

  await q("update workspaces set is_suspended = true where id = $1", [owner.workspace]);
  assert.equal((await as("authenticated", owner.id, (run) => run("select id from channels"))).length, 0);
  assert.equal((await inbound(ch.id, "sus", { text: "hi" })).ignored, true);
  await q("update workspaces set is_suspended = false where id = $1", [owner.workspace]);

  await q("update workspace_members set access_until = $1 where user_id = $2", [pastDate(), admin.id]);
  assert.equal((await as("authenticated", admin.id, (run) => run("select id from channels"))).length, 0);
  assert.equal((await as("authenticated", owner.id, (run) => run("select id from channels"))).length, 1, "владелец работает");
  const a = (await as("authenticated", admin.id, (run) => run("select my_access() as a")))[0].a;
  assert.equal(a.memberships[0].active, false);

  await q("update workspace_members set access_until = $1 where user_id = $2", [futureDate(), admin.id]);
  assert.equal((await as("authenticated", admin.id, (run) => run("select id from channels"))).length, 1);
});

test("владелец не может продлить себе срок или снять приостановку", async () => {
  const owner = await company("Школа", futureDate());
  await assert.rejects(as("authenticated", owner.id, (run) => run("update workspaces set access_until = null where id = $1", [owner.workspace])), /permission denied/);
  await assert.rejects(as("authenticated", owner.id, (run) => run("update workspaces set is_suspended = false where id = $1", [owner.workspace])), /permission denied/);
  await assert.rejects(as("authenticated", owner.id, (run) => run("update workspace_members set access_until = null where user_id = $1", [owner.id])), /permission denied/);
  await assert.rejects(as("authenticated", owner.id, (run) => run("select platform_extend_access($1, 12)", [owner.workspace])), /permission denied/);
  await assert.rejects(as("authenticated", owner.id, (run) => run("select platform_create_company('x', $1, 'x@x.x')", [owner.id])), /permission denied/);
  await assert.rejects(as("authenticated", owner.id, (run) => run("select service_member_role($1, $2)", [owner.workspace, owner.id])), /permission denied/);
  await assert.rejects(as("authenticated", owner.id, (run) => run("select * from platform_admins")), /permission denied/);
  await assert.rejects(as("authenticated", owner.id, (run) => run("insert into platform_admins (user_id) values ($1)", [owner.id])), /permission denied/);
  await assert.rejects(as("anon", null, (run) => run("select my_access()")), /permission denied/);
});

test("my_access показывает главного админа только ему самому", async () => {
  const boss = await signup();
  await q("insert into platform_admins (user_id) values ($1)", [boss.id]);
  const other = await company();
  assert.equal((await as("authenticated", boss.id, (run) => run("select my_access() as a")))[0].a.is_platform_admin, true);
  assert.deepEqual((await as("authenticated", boss.id, (run) => run("select my_access() as a")))[0].a.memberships, []);
  assert.equal((await as("authenticated", other.id, (run) => run("select my_access() as a")))[0].a.is_platform_admin, false);
  // Статус главного админа не открывает чужие данные через браузер.
  assert.equal((await as("authenticated", boss.id, (run) => run("select id from workspaces where id = $1", [other.workspace]))).length, 0);
});

test("уроки: администратор добавляет клиента и ученика вручную, чужие данные закрыты", async () => {
  const { owner, ch } = await setup();
  const admin = await staff(owner.workspace);
  const stranger = await setup();
  await inbound(ch.id, "stud", { text: "hi" });
  const contact = await one("select id from contacts where channel_id = $1 and external_id = 'stud'", [ch.id]);
  await inbound(stranger.ch.id, "alien", { text: "hi" });
  const alien = await one("select id from contacts where channel_id = $1 and external_id = 'alien'", [stranger.ch.id]);

  const lesson = (await as("authenticated", admin.id, (run) => run(
    "insert into lessons (workspace_id, title, starts_at, notes) values ($1, 'Английский A1', now() + interval '2 days', 'Кабинет 3, принести тетрадь') returning *",
    [owner.workspace],
  )))[0];
  assert.equal(lesson.created_by, admin.id);

  await as("authenticated", admin.id, (run) => run(
    "insert into lesson_students (workspace_id, lesson_id, contact_id, name, phone) values ($1, $2, $3, 'Анна', '+998901112233')",
    [owner.workspace, lesson.id, contact.id],
  ));
  await as("authenticated", admin.id, (run) => run(
    "insert into lesson_students (workspace_id, lesson_id, name, note) values ($1, $2, 'Вали', 'Пришёл по звонку')",
    [owner.workspace, lesson.id],
  ));
  await assert.rejects(
    as("authenticated", admin.id, (run) => run(
      "insert into lesson_students (workspace_id, lesson_id, contact_id, name) values ($1, $2, $3, 'Анна снова')",
      [owner.workspace, lesson.id, contact.id],
    )),
    /lesson_students_lesson_id_contact_id_key/,
    "один клиент не добавляется в урок дважды",
  );
  assert.equal((await as("authenticated", owner.id, (run) => run("select id from lesson_students where lesson_id = $1", [lesson.id]))).length, 2);

  // Чужой клиент и чужой урок не подставить.
  await assert.rejects(
    as("authenticated", admin.id, (run) => run(
      "insert into lesson_students (workspace_id, lesson_id, contact_id, name) values ($1, $2, $3, 'Чужой')",
      [owner.workspace, lesson.id, alien.id],
    )),
    /row-level security/,
  );
  await assert.rejects(
    as("authenticated", stranger.owner.id, (run) => run(
      "insert into lesson_students (workspace_id, lesson_id, name) values ($1, $2, 'Чужой')",
      [stranger.owner.workspace, lesson.id],
    )),
    /row-level security/,
  );
  await assert.rejects(
    as("authenticated", stranger.owner.id, (run) => run("insert into lessons (workspace_id, title) values ($1, 'x')", [owner.workspace])),
    /row-level security/,
  );
  assert.equal((await as("authenticated", stranger.owner.id, (run) => run("select * from lessons where id = $1", [lesson.id]))).length, 0);
  assert.equal((await as("authenticated", stranger.owner.id, (run) => run("update lessons set title = 'x' where id = $1 returning id", [lesson.id]))).length, 0);
  assert.equal((await as("authenticated", stranger.owner.id, (run) => run("delete from lessons where id = $1 returning id", [lesson.id]))).length, 0);
  await assert.rejects(as("anon", null, (run) => run("select * from lessons")), /permission denied/);
  await assert.rejects(as("authenticated", admin.id, (run) => run("update lessons set workspace_id = $1 where id = $2", [stranger.owner.workspace, lesson.id])), /permission denied/);

  // Удаление урока убирает записи, удаление клиента оставляет ученика в уроке.
  await q("delete from contacts where id = $1", [contact.id]);
  const left = await q("select contact_id, name from lesson_students where lesson_id = $1 and name = 'Анна'", [lesson.id]);
  assert.deepEqual(left, [{ contact_id: null, name: "Анна" }]);
  await as("authenticated", admin.id, (run) => run("delete from lessons where id = $1", [lesson.id]));
  assert.equal((await q("select 1 from lesson_students where lesson_id = $1", [lesson.id])).length, 0);
});

test("поддержка закрыта для анонимов и не даёт подделать отправителя", async () => {
  const owner = await company();
  await assert.rejects(as("anon", null, (run) => run("select * from support_messages")), /permission denied/);
  await assert.rejects(as("anon", null, (run) => run("select support_send($1, 'x')", [owner.workspace])), /permission denied/);
  await assert.rejects(as("anon", null, (run) => run("select platform_support_threads()")), /permission denied/);
  await assert.rejects(
    as("authenticated", owner.id, (run) => run("insert into support_messages (workspace_id, sender, text) values ($1, 'platform', 'x')", [owner.workspace])),
    /permission denied/,
  );
  await assert.rejects(as("authenticated", owner.id, (run) => run("update support_messages set read_at = now()")), /permission denied/);

  const id = (await as("authenticated", owner.id, (run) => run("select support_send($1, 'Здравствуйте') as id", [owner.workspace])))[0].id;
  const row = await one("select sender, author_id, author_email from support_messages where id = $1", [id]);
  assert.deepEqual(row, { sender: "owner", author_id: owner.id, author_email: owner.email });
});

test("удаление компании удаляет и переписку с поддержкой", async () => {
  const owner = await company();
  await as("authenticated", owner.id, (run) => run("select support_send($1, 'Здравствуйте')", [owner.workspace]));
  await q("delete from workspaces where id = $1", [owner.workspace]);
  assert.equal((await q("select 1 from support_messages where workspace_id = $1", [owner.workspace])).length, 0);
});

// Ученик из заявки на уроке через заданное число минут.
async function studentOnLesson(minutes, { remind = true, price = 0 } = {}) {
  const { owner, ch } = await setup();
  const user = uid("tg");
  await inbound(ch.id, user, { text: "Привет" });
  const contact = await one("select * from contacts where channel_id = $1 and external_id = $2", [ch.id, user]);
  const lesson = await one(
    "insert into lessons (workspace_id, title, starts_at, remind, price) values ($1, 'Английский', now() + make_interval(mins => $2), $3, $4) returning *",
    [owner.workspace, minutes, remind, price],
  );
  const student = await one(
    "insert into lesson_students (workspace_id, lesson_id, contact_id, name) values ($1, $2, $3, 'Анна') returning *",
    [owner.workspace, lesson.id, contact.id],
  );
  return { owner, ch, user, contact, lesson, student };
}

const claim = async () => (await one("select lesson_reminders_claim() as r")).r;
const claimFor = async (channelId) => (await claim()).filter((m) => m.channel_id === channelId);

test("напоминание за день уходит один раз, за три часа до урока только напоминание за час", async () => {
  const far = await studentOnLesson(26 * 60);
  assert.deepEqual(await claimFor(far.ch.id), []);

  const day = await studentOnLesson(10 * 60);
  const [first, ...rest] = await claimFor(day.ch.id);
  assert.equal(rest.length, 0);
  assert.match(first.text, /^Напоминаем: (сегодня|завтра) в \d\d:\d\d урок «Английский»\. Ждём вас!$/);
  assert.equal(first.external_id, day.user);
  assert.deepEqual(await claimFor(day.ch.id), [], "повторно то же напоминание не выбирается");
  const message = await one("select sender, status, direction from messages where id = $1", [first.message_id]);
  assert.deepEqual(message, { sender: "bot", status: "queued", direction: "out" });

  const close = await studentOnLesson(50);
  const due = await claimFor(close.ch.id);
  assert.equal(due.length, 1);
  assert.match(due[0].text, /^Скоро начало: /);
  const { kind } = await one("select kind from lesson_reminders where student_id = $1", [close.student.id]);
  assert.equal(kind, "hour");

  const middle = await studentOnLesson(2 * 60);
  assert.deepEqual(await claimFor(middle.ch.id), [], "за два часа ещё рано для напоминания за час и поздно для дня");

  const past = await studentOnLesson(-30);
  assert.deepEqual(await claimFor(past.ch.id), []);
});

test("перенос урока даёт новое напоминание, выключенные и неактивные не получают", async () => {
  const moved = await studentOnLesson(50);
  assert.equal((await claimFor(moved.ch.id)).length, 1);
  await q("update lessons set starts_at = now() + interval '40 minutes' where id = $1", [moved.lesson.id]);
  assert.equal((await claimFor(moved.ch.id)).length, 1);

  const off = await studentOnLesson(50, { remind: false });
  assert.deepEqual(await claimFor(off.ch.id), []);

  const absent = await studentOnLesson(50);
  await q("update lesson_students set attended = false where id = $1", [absent.student.id]);
  assert.deepEqual(await claimFor(absent.ch.id), []);

  const expired = await studentOnLesson(50);
  await q("update workspaces set access_until = now() - interval '1 hour' where id = $1", [expired.owner.workspace]);
  assert.deepEqual(await claimFor(expired.ch.id), []);

  const botOff = await studentOnLesson(50);
  await q("update channels set is_active = false where id = $1", [botOff.ch.id]);
  assert.deepEqual(await claimFor(botOff.ch.id), []);
  const skipped = await one("select error, message_id from lesson_reminders where student_id = $1", [botOff.student.id]);
  assert.deepEqual(skipped, { error: "В этом канале выключен бот", message_id: null });

  // Ученику, добавленному вручную, писать некуда.
  const manual = await studentOnLesson(50);
  await q("update lesson_students set contact_id = null where id = $1", [manual.student.id]);
  assert.deepEqual(await claimFor(manual.ch.id), []);
});

test("ответ на напоминание возвращает заявку администратору, опрос не начинается заново", async () => {
  const { ch, user, contact } = await studentOnLesson(50);
  await inbound(ch.id, user, { option: "sat" });
  await inbound(ch.id, user, { text: "Анна" });
  await inbound(ch.id, user, { text: "+998901234567" });
  await inbound(ch.id, user, { option: "skip" });
  const lead = await one("select * from leads where contact_id = $1", [contact.id]);
  await q("update leads set status = 'done', closed_at = now() - interval '30 days' where id = $1", [lead.id]);

  const [due] = await claimFor(ch.id);
  await q("select bot_message_result($1, 'ext-1')", [due.message_id]);

  const reply = await inbound(ch.id, user, { text: "Спасибо, приду" });
  assert.deepEqual(reply.outbound, []);
  assert.equal(reply.lead_id, lead.id);
  const fresh = await one("select status, closed_at, assigned_to from leads where id = $1", [lead.id]);
  assert.deepEqual(fresh, { status: "new", closed_at: null, assigned_to: null });
  assert.equal((await q("select 1 from leads where contact_id = $1", [contact.id])).length, 1);
});

test("долг считается сам, цена урока доходит до учеников, кроме особой цены", async () => {
  const { owner, lesson, student } = await studentOnLesson(600, { price: 300000 });
  assert.equal(Number(student.price), 300000, "новый ученик получает цену урока");
  assert.equal(Number(student.debt), 300000);

  const special = await one(
    "insert into lesson_students (workspace_id, lesson_id, name, price) values ($1, $2, 'Борис', 150000) returning *",
    [owner.workspace, lesson.id],
  );
  assert.equal(Number(special.price), 150000);

  await as("authenticated", owner.id, async (run) => {
    await run("update lesson_students set paid = 100000, attended = true where id = $1", [student.id]);
    await run("update lessons set price = 400000 where id = $1", [lesson.id]);
  });
  const updated = await one("select price, paid, debt, attended from lesson_students where id = $1", [student.id]);
  assert.deepEqual([Number(updated.price), Number(updated.paid), Number(updated.debt), updated.attended], [400000, 100000, 300000, true]);
  assert.equal(Number((await one("select price from lesson_students where id = $1", [special.id])).price), 150000);

  // Переплата не даёт отрицательного долга, отрицательную сумму записать нельзя.
  await q("update lesson_students set paid = 999000 where id = $1", [student.id]);
  assert.equal(Number((await one("select debt from lesson_students where id = $1", [student.id])).debt), 0);
  await assert.rejects(q("update lesson_students set paid = -1 where id = $1", [student.id]), /check constraint/);
  await assert.rejects(q("update lesson_students set debt = 1 where id = $1", [student.id]), /can only be updated to DEFAULT/);
});

test("напоминание о конце срока приходит за 7, 3 и 1 день по одному разу, продление начинает заново", async () => {
  const owner = await company("Срок", new Date(Date.now() + 6.5 * 86400000));
  const reminders = () => q("select sender, text, author_id from support_messages where workspace_id = $1 order by created_at", [owner.workspace]);
  const run = () => q("select private.send_term_reminders()");
  const setLeft = (days) => q("update workspaces set access_until = now() + make_interval(hours => $1) where id = $2", [Math.round(days * 24), owner.workspace]);
  await run();
  await run();
  let list = await reminders();
  assert.equal(list.length, 1);
  assert.equal(list[0].sender, "platform");
  assert.equal(list[0].author_id, null);
  assert.match(list[0].text, /осталось 7 дн\./);
  assert.match(list[0].text, /заканчивается \d+ [а-я]+,/);

  await setLeft(2.5);
  await run();
  await run();
  list = await reminders();
  assert.equal(list.length, 2);
  assert.match(list[1].text, /осталось 3 дн\./);

  await setLeft(0.5);
  await run();
  list = await reminders();
  assert.equal(list.length, 3);
  assert.match(list[2].text, /осталось 1 дн\./);

  // Новый срок после продления: снова предупредим, когда он станет близко.
  await setLeft(6);
  await run();
  assert.equal((await reminders()).length, 4);

  const unsuspended = await company("Приостановлена", new Date(Date.now() + 86400000 * 2));
  await q("update workspaces set is_suspended = true where id = $1", [unsuspended.workspace]);
  await run();
  assert.equal((await q("select 1 from support_messages where workspace_id = $1", [unsuspended.workspace])).length, 0);

  const farAway = await company("Далеко", new Date(Date.now() + 86400000 * 30));
  await run();
  assert.equal((await q("select 1 from support_messages where workspace_id = $1", [farAway.workspace])).length, 0);

  // Владелец не может подделать сообщение и вызвать рассылку.
  await assert.rejects(as("authenticated", owner.id, (r) => r("select private.send_term_reminders()")), /permission denied/);
  await assert.rejects(as("authenticated", owner.id, (r) => r("select private.call_edge_function('reminders')")), /permission denied/);
  await assert.rejects(as("authenticated", owner.id, (r) => r("select lesson_reminders_claim()")), /permission denied/);
});

test("быстрые ответы и напоминания видны только своей компании, удаляются вместе с ней", async () => {
  const mine = await studentOnLesson(50);
  const other = await company("Чужая");
  await claimFor(mine.ch.id);
  const reply = await as("authenticated", mine.owner.id, (run) =>
    run("insert into quick_replies (workspace_id, title, text) values ($1, 'Цены', '300 000 сум') returning *", [mine.owner.workspace]));
  assert.equal(reply[0].title, "Цены");

  assert.equal((await as("authenticated", other.id, (run) => run("select * from quick_replies where workspace_id = $1", [mine.owner.workspace]))).length, 0);
  assert.equal((await as("authenticated", other.id, (run) => run("select * from lesson_reminders where workspace_id = $1", [mine.owner.workspace]))).length, 0);
  await assert.rejects(
    as("authenticated", other.id, (run) => run("insert into quick_replies (workspace_id, title, text) values ($1, 'x', 'y')", [mine.owner.workspace])),
    /row-level security/,
  );
  await as("authenticated", other.id, (run) => run("update quick_replies set text = 'взлом' where id = $1", [reply[0].id]));
  assert.equal((await one("select text from quick_replies where id = $1", [reply[0].id])).text, "300 000 сум");
  await assert.rejects(as("authenticated", mine.owner.id, (run) => run("insert into lesson_reminders (workspace_id, student_id, kind, starts_at) values ($1, $2, 'day', now())", [mine.owner.workspace, mine.student.id])), /permission denied/);
  await assert.rejects(as("anon", null, (run) => run("select * from quick_replies")), /permission denied/);

  await q("delete from workspaces where id = $1", [mine.owner.workspace]);
  assert.equal((await q("select 1 from quick_replies where workspace_id = $1", [mine.owner.workspace])).length, 0);
  assert.equal((await q("select 1 from lesson_reminders where workspace_id = $1", [mine.owner.workspace])).length, 0);
  assert.equal((await q("select 1 from private.term_reminders where workspace_id = $1", [mine.owner.workspace])).length, 0);
});
