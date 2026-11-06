-- Посещаемость и оплаты, напоминания об уроках и о конце срока, быстрые ответы, расписание.

-- ---------------------------------------------------------------------------
-- Посещаемость и оплаты
-- ---------------------------------------------------------------------------

-- Уже созданные уроки не начинают писать клиентам сами: напоминания включаются в самом уроке.
alter table public.lessons
  add column price bigint not null default 0 check (price between 0 and 1000000000000),
  add column remind boolean not null default false;
alter table public.lessons alter column remind set default true;

alter table public.lesson_students
  add column attended boolean,
  add column price bigint not null default 0 check (price between 0 and 1000000000000),
  add column paid bigint not null default 0 check (paid between 0 and 1000000000000),
  add column debt bigint generated always as (greatest(price - paid, 0)) stored;

create index lesson_students_debt_idx on public.lesson_students (workspace_id) where price > 0 or paid > 0;

-- Новый ученик получает цену урока, если ему не задали свою.
create function private.lesson_student_price() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.price = 0 then
    select price into new.price from public.lessons where id = new.lesson_id;
  end if;
  return new;
end;
$$;

create trigger lesson_students_price
  before insert on public.lesson_students
  for each row execute function private.lesson_student_price();

-- Новая цена урока меняет цену у тех, кому не ставили особую.
create function private.lesson_price_changed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.lesson_students set price = new.price
  where lesson_id = new.id and price = old.price;
  return new;
end;
$$;

create trigger lessons_price_changed
  after update of price on public.lessons
  for each row when (old.price is distinct from new.price)
  execute function private.lesson_price_changed();

grant update (title, starts_at, duration_minutes, notes, price, remind) on public.lessons to authenticated;
grant update (name, phone, note, attended, price, paid) on public.lesson_students to authenticated;

-- ---------------------------------------------------------------------------
-- Быстрые ответы
-- ---------------------------------------------------------------------------

create table public.quick_replies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 40),
  text text not null check (length(btrim(text)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index quick_replies_workspace_idx on public.quick_replies (workspace_id, created_at);

alter table public.quick_replies enable row level security;

create policy quick_replies_select on public.quick_replies for select to authenticated
  using (private.is_member(workspace_id));
create policy quick_replies_insert on public.quick_replies for insert to authenticated
  with check (private.is_member(workspace_id));
create policy quick_replies_update on public.quick_replies for update to authenticated
  using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));
create policy quick_replies_delete on public.quick_replies for delete to authenticated
  using (private.is_member(workspace_id));

revoke all on public.quick_replies from anon, authenticated, public;
grant all on public.quick_replies to service_role;
grant select, insert, delete on public.quick_replies to authenticated;
grant update (title, text) on public.quick_replies to authenticated;

-- ---------------------------------------------------------------------------
-- Напоминания ученикам об уроке
-- ---------------------------------------------------------------------------

-- Дата по времени Ташкента: компании работают в Узбекистане.
create function private.ru_date(p_at timestamptz) returns text
language sql stable set search_path = pg_catalog as $$
  select extract(day from p_at at time zone 'Asia/Tashkent')::integer || ' ' ||
    (array['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'])
      [extract(month from p_at at time zone 'Asia/Tashkent')::integer];
$$;

create function private.lesson_when(p_at timestamptz) returns text
language sql stable set search_path = pg_catalog as $$
  select case (p_at at time zone 'Asia/Tashkent')::date - (now() at time zone 'Asia/Tashkent')::date
      when 0 then 'сегодня'
      when 1 then 'завтра'
      else private.ru_date(p_at)
    end || ' в ' || to_char(p_at at time zone 'Asia/Tashkent', 'HH24:MI');
$$;

-- Одно напоминание ученику на каждое время урока: при переносе урока придёт новое.
create table public.lesson_reminders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  student_id uuid not null references public.lesson_students (id) on delete cascade,
  kind text not null check (kind in ('day', 'hour')),
  starts_at timestamptz not null,
  message_id uuid references public.messages (id) on delete set null,
  -- Причина, если сообщение даже не создавалось. Остальное видно в самом сообщении.
  error text,
  created_at timestamptz not null default now(),
  unique (student_id, kind, starts_at)
);
create index lesson_reminders_message_idx on public.lesson_reminders (message_id);

alter table public.lesson_reminders enable row level security;
create policy lesson_reminders_select on public.lesson_reminders for select to authenticated
  using (private.is_member(workspace_id));
revoke all on public.lesson_reminders from anon, authenticated, public;
grant all on public.lesson_reminders to service_role;
grant select on public.lesson_reminders to authenticated;

-- Отбирает, что пора отправить, и сразу создаёт сообщения. Повторно то же самое не выберет.
create function public.lesson_reminders_claim(p_limit integer default 100) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_reminder uuid;
  v_lead uuid;
  v_message uuid;
  v_text text;
  v_out jsonb := '[]'::jsonb;
begin
  -- Функцию могли прервать на середине: такие сообщения не должны висеть как «Отправляется…».
  update public.messages m set status = 'failed', error = 'Напоминание не удалось отправить'
  from public.lesson_reminders x
  where x.message_id = m.id and m.status = 'queued' and m.created_at < now() - interval '15 minutes';

  for r in
    select
      s.id as student_id, s.contact_id, l.workspace_id, l.title, l.starts_at, k.kind,
      ct.channel_id, ct.external_id, ct.meta,
      ch.platform, ch.name as channel_name, ch.is_active, ch.deleted_at
    from public.lesson_students s
    join public.lessons l on l.id = s.lesson_id
    join public.workspaces w on w.id = l.workspace_id
    join public.contacts ct on ct.id = s.contact_id
    join public.channels ch on ch.id = ct.channel_id
    cross join lateral (values ('day'), ('hour')) as k(kind)
    where l.remind
      and l.starts_at > now()
      and s.attended is distinct from false
      and not w.is_suspended
      and (w.access_until is null or w.access_until > now())
      and (
        (k.kind = 'hour' and l.starts_at <= now() + interval '1 hour')
        -- Если до урока меньше трёх часов, хватит одного напоминания за час.
        or (k.kind = 'day' and l.starts_at <= now() + interval '24 hours' and l.starts_at > now() + interval '3 hours')
      )
      and not exists (
        select 1 from public.lesson_reminders x
        where x.student_id = s.id and x.kind = k.kind and x.starts_at = l.starts_at
      )
    order by l.starts_at
    limit greatest(p_limit, 1)
  loop
    insert into public.lesson_reminders (workspace_id, student_id, kind, starts_at)
    values (r.workspace_id, r.student_id, r.kind, r.starts_at)
    on conflict (student_id, kind, starts_at) do nothing
    returning id into v_reminder;
    continue when v_reminder is null;

    if r.deleted_at is not null or not r.is_active then
      update public.lesson_reminders
      set error = case when r.deleted_at is not null then 'Канал отключён' else 'В этом канале выключен бот' end
      where id = v_reminder;
      continue;
    end if;

    select id into v_lead from public.leads where contact_id = r.contact_id order by created_at desc limit 1;
    if v_lead is null then
      update public.lesson_reminders set error = 'У клиента нет заявки' where id = v_reminder;
      continue;
    end if;

    v_text := case r.kind
      when 'day' then 'Напоминаем: ' || private.lesson_when(r.starts_at) || ' урок «' || r.title || '». Ждём вас!'
      else 'Скоро начало: ' || private.lesson_when(r.starts_at) || ' урок «' || r.title || '». Ждём вас!'
    end;

    insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, status)
    values (r.workspace_id, v_lead, r.channel_id, 'out', 'bot', v_text, 'queued')
    returning id into v_message;

    update public.lesson_reminders set message_id = v_message where id = v_reminder;

    v_out := v_out || jsonb_build_object(
      'message_id', v_message,
      'text', v_text,
      'channel_id', r.channel_id,
      'platform', r.platform,
      'channel_name', r.channel_name,
      'external_id', r.external_id,
      'meta', r.meta
    );
  end loop;

  return v_out;
end;
$$;

revoke all on function public.lesson_reminders_claim(integer) from anon, authenticated, public;
grant execute on function public.lesson_reminders_claim(integer) to service_role;

-- Ответ на напоминание не должен запускать опрос заново: он возвращает заявку администратору.
create or replace function public.bot_handle_inbound(
  p_channel_id uuid,
  p_external_user_id text,
  p_external_message_id text,
  p_text text default null,
  p_option_id text default null,
  p_display_name text default null,
  p_username text default null,
  p_contact_meta jsonb default '{}'::jsonb,
  p_attachment text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1
    from public.channels c
    join public.workspaces w on w.id = c.workspace_id
    where c.id = p_channel_id
      and not w.is_suspended
      and (w.access_until is null or w.access_until > now())
  ) then
    return jsonb_build_object('ignored', true);
  end if;

  update public.leads l set
    status = case when l.assigned_to is null then 'new' else 'in_work' end,
    closed_at = null
  where l.id = (
      select x.id
      from public.contacts c
      join public.leads x on x.contact_id = c.id
      where c.channel_id = p_channel_id and c.external_id = p_external_user_id
      order by x.created_at desc
      limit 1
    )
    and l.status in ('done', 'rejected')
    and exists (select 1 from public.channels ch where ch.id = p_channel_id and ch.is_active and ch.deleted_at is null)
    and exists (
      select 1
      from public.lesson_reminders r
      join public.lesson_students s on s.id = r.student_id
      join public.messages m on m.id = r.message_id
      where s.contact_id = l.contact_id
        and m.status = 'sent'
        and r.created_at > now() - interval '48 hours'
    );

  return private.bot_handle_inbound_core(
    p_channel_id, p_external_user_id, p_external_message_id, p_text, p_option_id,
    p_display_name, p_username, p_contact_meta, p_attachment
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Напоминание владельцу о конце срока: сообщение в «Поддержке Qabul» за 7, 3 и 1 день
-- ---------------------------------------------------------------------------

create table private.term_reminders (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  access_until timestamptz not null,
  days integer not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, access_until, days)
);

create function private.send_term_reminders() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_left integer;
  v_mark integer;
  v_sent integer := 0;
begin
  for r in
    select id, access_until from public.workspaces
    where not is_suspended and access_until > now() and access_until <= now() + interval '7 days'
  loop
    v_left := ceil(extract(epoch from r.access_until - now()) / 86400)::integer;
    v_mark := case when v_left <= 1 then 1 when v_left <= 3 then 3 else 7 end;

    insert into private.term_reminders (workspace_id, access_until, days)
    values (r.id, r.access_until, v_mark)
    on conflict do nothing;
    continue when not found;

    insert into public.support_messages (workspace_id, sender, text)
    values (
      r.id,
      'platform',
      'Доступ к Qabul заканчивается ' || private.ru_date(r.access_until) || ', осталось ' || v_left || ' дн. ' ||
      'После этого кабинет закроется, бот перестанет отвечать клиентам, а их новые сообщения не сохранятся. ' ||
      'Чтобы продлить доступ, напишите нам здесь.'
    );
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end;
$$;

-- ---------------------------------------------------------------------------
-- Расписание. Адрес функций и секрет лежат в Vault, в коде их нет.
-- ---------------------------------------------------------------------------

create function private.call_edge_function(p_name text) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'qabul_functions_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'qabul_cron_secret';
  if v_url is null or v_secret is null then
    raise exception 'В Vault нет qabul_functions_url или qabul_cron_secret';
  end if;
  return net.http_post(
    url := v_url || '/' || p_name,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function
  private.lesson_student_price(),
  private.lesson_price_changed(),
  private.send_term_reminders(),
  private.call_edge_function(text),
  private.ru_date(timestamptz),
  private.lesson_when(timestamptz)
from anon, authenticated, public;

-- В локальных тестах этих расширений нет: там функции вызываются напрямую.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron with schema pg_catalog;
    create extension if not exists pg_net;

    perform cron.schedule('qabul-tokens-and-channels', '7 * * * *', $job$select private.call_edge_function('refresh-tokens')$job$);
    perform cron.schedule('qabul-lesson-reminders', '*/5 * * * *', $job$select private.call_edge_function('reminders')$job$);
    perform cron.schedule('qabul-term-reminders', '12 * * * *', $job$select private.send_term_reminders()$job$);
  end if;
end;
$$;
