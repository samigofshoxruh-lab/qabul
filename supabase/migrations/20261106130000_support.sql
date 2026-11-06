-- Поддержка Qabul: переписка владельца компании с главным админом.

create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  sender text not null check (sender in ('owner', 'platform')),
  author_id uuid references auth.users (id) on delete set null,
  author_email text,
  text text not null check (length(btrim(text)) between 1 and 4000),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index support_messages_thread_idx on public.support_messages (workspace_id, created_at);
create index support_messages_unread_idx on public.support_messages (sender) where read_at is null;

alter table public.support_messages enable row level security;

-- Намеренно без проверки срока: с истёкшим доступом владелец должен суметь попросить продление.
create function private.is_owner_any_term(p_workspace uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace and user_id = auth.uid() and role = 'owner'
  );
$$;

create function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create policy support_select on public.support_messages for select to authenticated
  using (private.is_owner_any_term(workspace_id) or private.is_platform_admin());

-- Запись только через функции: отправитель определяется сервером, подделать его нельзя.
create function public.support_send(p_workspace uuid, p_text text, p_as_platform boolean default false) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_text text := btrim(coalesce(p_text, ''));
  v_id uuid;
begin
  if p_as_platform then
    if not private.is_platform_admin() then
      raise exception 'Нет доступа' using errcode = '42501';
    end if;
  elsif not private.is_owner_any_term(p_workspace) then
    raise exception 'Писать в поддержку может только владелец компании' using errcode = '42501';
  end if;

  if v_text = '' or length(v_text) > 4000 then
    raise exception 'Напишите сообщение длиной до 4000 символов' using errcode = '22023';
  end if;

  insert into public.support_messages (workspace_id, sender, author_id, author_email, text)
  values (
    p_workspace,
    case when p_as_platform then 'platform' else 'owner' end,
    auth.uid(),
    (select email from auth.users where id = auth.uid()),
    v_text
  )
  returning id into v_id;
  return v_id;
end;
$$;

create function public.support_mark_read(p_workspace uuid, p_as_platform boolean default false) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.support_messages
  set read_at = now()
  where workspace_id = p_workspace
    and read_at is null
    and (
      (p_as_platform and sender = 'owner' and private.is_platform_admin())
      or (not p_as_platform and sender = 'platform' and private.is_owner_any_term(p_workspace))
    );
$$;

create function public.support_unread(p_as_platform boolean default false) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer
  from public.support_messages m
  where m.read_at is null
    and (
      (p_as_platform and m.sender = 'owner' and private.is_platform_admin())
      or (not p_as_platform and m.sender = 'platform' and private.is_owner_any_term(m.workspace_id))
    );
$$;

create function public.platform_support_threads() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Нет доступа' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(t order by t.last_at desc)
    from (
      select
        w.id as workspace_id,
        w.name,
        max(m.created_at) as last_at,
        (array_agg(m.text order by m.created_at desc))[1] as last_text,
        (array_agg(m.sender order by m.created_at desc))[1] as last_sender,
        count(*) filter (where m.sender = 'owner' and m.read_at is null) as unread
      from public.workspaces w
      join public.support_messages m on m.workspace_id = w.id
      group by w.id, w.name
    ) t
  ), '[]'::jsonb);
end;
$$;

revoke all on public.support_messages from anon, authenticated, public;
revoke all on function
  public.support_send(uuid, text, boolean),
  public.support_mark_read(uuid, boolean),
  public.support_unread(boolean),
  public.platform_support_threads()
from anon, authenticated, public;
revoke all on function private.is_owner_any_term(uuid), private.is_platform_admin() from public;

grant all on public.support_messages to service_role;
grant select on public.support_messages to authenticated;
grant execute on function private.is_owner_any_term(uuid), private.is_platform_admin() to authenticated, service_role;
grant execute on function
  public.support_send(uuid, text, boolean),
  public.support_mark_read(uuid, boolean),
  public.support_unread(boolean),
  public.platform_support_threads()
to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.support_messages;
  end if;
end;
$$;
