-- Главный админ, сроки доступа компаний и пользователей, уроки.

-- ---------------------------------------------------------------------------
-- Сроки доступа. Пустой срок означает «бессрочно».
-- ---------------------------------------------------------------------------

alter table public.workspaces
  add column access_until timestamptz,
  add column is_suspended boolean not null default false;

alter table public.workspace_members
  add column access_until timestamptz;

-- Кто главный админ, решает только сервер: у браузера нет доступа к этой таблице.
create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;

-- Все правила RLS опираются на эти две функции, поэтому истёкший срок
-- закрывает сразу все таблицы и действия кабинета.
create or replace function private.is_member(p_workspace uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
    from public.workspace_members m
    join public.workspaces w on w.id = m.workspace_id
    where m.workspace_id = p_workspace
      and m.user_id = auth.uid()
      and (m.access_until is null or m.access_until > now())
      and not w.is_suspended
      and (w.access_until is null or w.access_until > now())
  );
$$;

create or replace function private.is_owner(p_workspace uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
    from public.workspace_members m
    join public.workspaces w on w.id = m.workspace_id
    where m.workspace_id = p_workspace
      and m.user_id = auth.uid()
      and m.role = 'owner'
      and (m.access_until is null or m.access_until > now())
      and not w.is_suspended
      and (w.access_until is null or w.access_until > now())
  );
$$;

-- Регистрации больше нет: компании создаёт главный админ. Триггер только добавляет
-- приглашённого администратора в кабинет, остальным пользователям кабинет не создаётся.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_invited uuid := nullif(new.raw_app_meta_data ->> 'invited_workspace', '')::uuid;
begin
  if v_invited is not null then
    insert into public.workspace_members (workspace_id, user_id, role, email)
    values (v_invited, new.id, 'admin', new.email);
  end if;
  return new;
end;
$$;

-- Бот молчит, пока у компании истёк срок или доступ приостановлен.
alter function public.bot_handle_inbound(uuid, text, text, text, text, text, text, jsonb, text)
  rename to bot_handle_inbound_core;
alter function public.bot_handle_inbound_core(uuid, text, text, text, text, text, text, jsonb, text)
  set schema private;

create function public.bot_handle_inbound(
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

  return private.bot_handle_inbound_core(
    p_channel_id, p_external_user_id, p_external_message_id, p_text, p_option_id,
    p_display_name, p_username, p_contact_meta, p_attachment
  );
end;
$$;

create or replace function public.agent_queue_message(p_lead_id uuid, p_agent_id uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lead public.leads;
  v_contact public.contacts;
  v_id uuid;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found or public.service_member_role(v_lead.workspace_id, p_agent_id) is null then
    raise exception 'Заявка не найдена' using errcode = '42501';
  end if;

  select * into v_contact from public.contacts where id = v_lead.contact_id;

  update public.leads set
    status = case when status in ('collecting', 'new') then 'in_work' else status end,
    assigned_to = coalesce(assigned_to, p_agent_id),
    taken_at = coalesce(taken_at, now()),
    current_question_id = null,
    unread_count = 0
  where id = v_lead.id;

  insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, agent_id, text, status)
  values (v_lead.workspace_id, v_lead.id, v_lead.channel_id, 'out', 'agent', p_agent_id, p_text, 'queued')
  returning id into v_id;

  return jsonb_build_object(
    'message_id', v_id,
    'channel_id', v_lead.channel_id,
    'contact_external_id', v_contact.external_id,
    'contact_meta', v_contact.meta
  );
end;
$$;

-- Роль пользователя в компании, если доступ у него сейчас открыт. Иначе null.
create function public.service_member_role(p_workspace uuid, p_user uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select m.role
  from public.workspace_members m
  join public.workspaces w on w.id = m.workspace_id
  where m.workspace_id = p_workspace
    and m.user_id = p_user
    and (m.access_until is null or m.access_until > now())
    and not w.is_suspended
    and (w.access_until is null or w.access_until > now());
$$;

-- Что доступно вошедшему пользователю. Сайт по этому ответу выбирает, что показать.
create function public.my_access() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'is_platform_admin', exists (select 1 from public.platform_admins where user_id = auth.uid()),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'workspace_id', w.id,
        'name', w.name,
        'role', m.role,
        'access_until', least(w.access_until, m.access_until),
        'is_suspended', w.is_suspended,
        'active', not w.is_suspended
          and (w.access_until is null or w.access_until > now())
          and (m.access_until is null or m.access_until > now())
      ) order by m.created_at)
      from public.workspace_members m
      join public.workspaces w on w.id = m.workspace_id
      where m.user_id = auth.uid()
    ), '[]'::jsonb)
  );
$$;

create function public.platform_create_company(
  p_name text, p_owner_id uuid, p_owner_email text, p_access_until timestamptz default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_workspace uuid;
begin
  insert into public.workspaces (name, owner_id, access_until)
  values (btrim(p_name), p_owner_id, p_access_until)
  returning id into v_workspace;

  insert into public.workspace_members (workspace_id, user_id, role, email)
  values (v_workspace, p_owner_id, 'owner', p_owner_email);

  perform private.seed_workspace(v_workspace);
  return v_workspace;
end;
$$;

-- Продление считается от текущего срока, а если он уже прошёл или срока нет, то от сегодня.
create function public.platform_extend_access(p_workspace uuid, p_months integer) returns timestamptz
language sql security definer set search_path = public, pg_temp as $$
  update public.workspaces
  set access_until = greatest(coalesce(access_until, now()), now()) + make_interval(months => p_months)
  where id = p_workspace
  returning access_until;
$$;

-- ---------------------------------------------------------------------------
-- Уроки
-- ---------------------------------------------------------------------------

create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 200),
  starts_at timestamptz,
  duration_minutes integer check (duration_minutes between 1 and 1440),
  notes text check (length(notes) <= 20000),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index lessons_workspace_idx on public.lessons (workspace_id, starts_at);

create table public.lesson_students (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lesson_id uuid not null references public.lessons (id) on delete cascade,
  -- Клиент из заявок. У ученика, добавленного вручную, связи нет.
  contact_id uuid references public.contacts (id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 200),
  phone text check (length(phone) <= 40),
  note text check (length(note) <= 2000),
  created_at timestamptz not null default now(),
  unique (lesson_id, contact_id)
);
create index lesson_students_lesson_idx on public.lesson_students (lesson_id, created_at);
create index lesson_students_contact_idx on public.lesson_students (contact_id);

alter table public.lessons enable row level security;
alter table public.lesson_students enable row level security;

create policy lessons_select on public.lessons for select to authenticated
  using (private.is_member(workspace_id));
create policy lessons_insert on public.lessons for insert to authenticated
  with check (private.is_member(workspace_id));
create policy lessons_update on public.lessons for update to authenticated
  using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));
create policy lessons_delete on public.lessons for delete to authenticated
  using (private.is_member(workspace_id));

-- Урок и клиент должны принадлежать той же компании, что и запись ученика.
create policy lesson_students_select on public.lesson_students for select to authenticated
  using (private.is_member(workspace_id));
create policy lesson_students_insert on public.lesson_students for insert to authenticated
  with check (
    private.is_member(workspace_id)
    and exists (select 1 from public.lessons l where l.id = lesson_id and l.workspace_id = lesson_students.workspace_id)
    and (contact_id is null or exists (
      select 1 from public.contacts c where c.id = contact_id and c.workspace_id = lesson_students.workspace_id
    ))
  );
create policy lesson_students_update on public.lesson_students for update to authenticated
  using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));
create policy lesson_students_delete on public.lesson_students for delete to authenticated
  using (private.is_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

revoke all on public.platform_admins, public.lessons, public.lesson_students from anon, authenticated, public;

revoke all on function
  public.bot_handle_inbound(uuid, text, text, text, text, text, text, jsonb, text),
  public.service_member_role(uuid, uuid),
  public.my_access(),
  public.platform_create_company(text, uuid, text, timestamptz),
  public.platform_extend_access(uuid, integer)
from anon, authenticated, public;

revoke all on function private.bot_handle_inbound_core(uuid, text, text, text, text, text, text, jsonb, text)
from anon, authenticated, public, service_role;

grant all on public.platform_admins, public.lessons, public.lesson_students to service_role;

grant execute on function
  public.bot_handle_inbound(uuid, text, text, text, text, text, text, jsonb, text),
  public.service_member_role(uuid, uuid),
  public.platform_create_company(text, uuid, text, timestamptz),
  public.platform_extend_access(uuid, integer)
to service_role;

grant execute on function public.my_access() to authenticated, service_role;

grant select, insert, delete on public.lessons, public.lesson_students to authenticated;
grant update (title, starts_at, duration_minutes, notes) on public.lessons to authenticated;
grant update (name, phone, note) on public.lesson_students to authenticated;
