-- CRM-бот: схема, RLS и логика опроса.
-- Логика бота живёт в Postgres, чтобы каждое входящее сообщение обрабатывалось
-- одной транзакцией: параллельные webhook-и не создадут дублей и не собьют опрос.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Таблицы
-- ---------------------------------------------------------------------------

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Моя компания' check (length(btrim(name)) between 1 and 120),
  owner_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin')),
  email text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);

create table public.surveys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  welcome_text text,
  completion_text text,
  is_default boolean not null default false,
  restart_after_hours integer not null default 24 check (restart_after_hours between 0 and 8760),
  created_at timestamptz not null default now()
);
create index surveys_workspace_idx on public.surveys (workspace_id);
create unique index surveys_one_default_idx on public.surveys (workspace_id) where is_default;

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys (id) on delete cascade,
  position integer not null default 0,
  type text not null default 'text' check (type in ('choice', 'text', 'phone')),
  text text not null check (length(btrim(text)) between 1 and 900),
  options jsonb not null default '[]'::jsonb,
  allow_other boolean not null default false,
  required boolean not null default true,
  created_at timestamptz not null default now(),
  constraint questions_options_shape check (
    jsonb_typeof(options) = 'array'
    and (type <> 'choice' or jsonb_array_length(options) between 2 and 10)
  )
);
create index questions_survey_idx on public.questions (survey_id, position);

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  platform text not null check (platform in ('telegram', 'instagram', 'facebook', 'whatsapp', 'viber', 'vk')),
  name text not null,
  external_id text not null,
  username text,
  survey_id uuid references public.surveys (id) on delete set null,
  is_active boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'active', 'error')),
  token_hint text,
  token_expires_at timestamptz,
  last_event_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index channels_workspace_idx on public.channels (workspace_id);
create unique index channels_account_idx on public.channels (platform, external_id) where deleted_at is null;

-- Токены лежат зашифрованными и недоступны браузеру: RLS включён, политик нет.
create table public.channel_secrets (
  channel_id uuid primary key references public.channels (id) on delete cascade,
  token_enc text not null,
  app_secret_enc text,
  webhook_secret text not null,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete cascade,
  external_id text not null,
  display_name text,
  username text,
  phone text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (channel_id, external_id)
);
create index contacts_workspace_idx on public.contacts (workspace_id);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  survey_id uuid references public.surveys (id) on delete set null,
  status text not null check (status in ('collecting', 'new', 'in_work', 'done', 'rejected')),
  current_question_id uuid references public.questions (id) on delete set null,
  invalid_attempts integer not null default 0,
  handoff boolean not null default false,
  assigned_to uuid references auth.users (id) on delete set null,
  taken_at timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  note text,
  unread_count integer not null default 0,
  last_message_at timestamptz not null default now(),
  last_message_preview text,
  created_at timestamptz not null default now()
);
create index leads_inbox_idx on public.leads (workspace_id, status, last_message_at desc);
create index leads_contact_idx on public.leads (contact_id, created_at desc);
create unique index leads_one_open_idx on public.leads (contact_id)
  where status in ('collecting', 'new', 'in_work');

create table public.answers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  question_id uuid references public.questions (id) on delete set null,
  question_text text not null,
  position integer not null default 0,
  answer_text text,
  option_id text,
  created_at timestamptz not null default now(),
  unique (lead_id, question_id)
);
create index answers_lead_idx on public.answers (lead_id, position);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  sender text not null check (sender in ('contact', 'bot', 'agent')),
  agent_id uuid references auth.users (id) on delete set null,
  text text,
  options jsonb not null default '[]'::jsonb,
  attachment text,
  external_id text,
  status text not null default 'received' check (status in ('received', 'queued', 'sent', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create index messages_lead_idx on public.messages (lead_id, created_at);
create unique index messages_external_idx on public.messages (channel_id, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------------------
-- Вспомогательные функции для RLS
-- ---------------------------------------------------------------------------

create function private.is_member(p_workspace uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace and user_id = auth.uid()
  );
$$;

create function private.is_owner(p_workspace uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace and user_id = auth.uid() and role = 'owner'
  );
$$;

revoke all on function private.is_member(uuid), private.is_owner(uuid) from public;
grant execute on function private.is_member(uuid), private.is_owner(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Триггеры
-- ---------------------------------------------------------------------------

create function private.seed_workspace(p_workspace uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.surveys (workspace_id, name, welcome_text, completion_text, is_default)
  values (
    p_workspace,
    'Основной опрос',
    'Здравствуйте! Задам несколько коротких вопросов, чтобы мы могли вам помочь.',
    'Спасибо! Ответы получены, администратор скоро свяжется с вами.',
    true
  );
$$;

-- Приглашение читается только из app_metadata: его может задать лишь сервер.
-- user_metadata заполняет сам пользователь при регистрации, ему доверять нельзя.
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_workspace uuid;
  v_invited uuid := nullif(new.raw_app_meta_data ->> 'invited_workspace', '')::uuid;
begin
  if v_invited is not null then
    insert into public.workspace_members (workspace_id, user_id, role, email)
    values (v_invited, new.id, 'admin', new.email);
    return new;
  end if;

  insert into public.workspaces (name, owner_id)
  values (coalesce(nullif(btrim(left(new.raw_user_meta_data ->> 'company', 120)), ''), 'Моя компания'), new.id)
  returning id into v_workspace;

  insert into public.workspace_members (workspace_id, user_id, role, email)
  values (v_workspace, new.id, 'owner', new.email);

  perform private.seed_workspace(v_workspace);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create function private.on_message_insert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.leads set
    last_message_at = new.created_at,
    last_message_preview = left(coalesce(new.text, new.attachment, ''), 140),
    unread_count = unread_count + case when new.direction = 'in' then 1 else 0 end
  where id = new.lead_id;
  return new;
end;
$$;

create trigger messages_after_insert
  after insert on public.messages
  for each row execute function private.on_message_insert();

-- ---------------------------------------------------------------------------
-- Логика опроса
-- ---------------------------------------------------------------------------

-- Текст и кнопки вопроса в том виде, в каком их получает клиент.
create function private.question_payload(q public.questions) returns jsonb
language plpgsql stable as $$
declare
  v_options jsonb := case when q.type = 'choice' then q.options else '[]'::jsonb end;
  v_text text := q.text;
begin
  if not q.required then
    v_options := v_options || jsonb_build_array(jsonb_build_object('id', 'skip', 'label', 'Пропустить'));
  end if;
  if q.type = 'choice' and q.allow_other then
    v_text := v_text || E'\n\nВыберите вариант или напишите свой.';
  end if;
  return jsonb_build_object('text', v_text, 'options', v_options);
end;
$$;

-- Следующий вопрос: первый по порядку, на который ещё нет ответа. Такой поиск
-- выдерживает правки опроса владельцем прямо во время чужого прохождения.
create function private.next_question(p_lead uuid, p_survey uuid) returns public.questions
language sql stable as $$
  select q.* from public.questions q
  where q.survey_id = p_survey
    and not exists (select 1 from public.answers a where a.lead_id = p_lead and a.question_id = q.id)
  order by q.position, q.created_at, q.id
  limit 1;
$$;

create function private.queue_out(
  p_lead uuid, p_workspace uuid, p_channel uuid, p_text text, p_options jsonb default '[]'::jsonb
) returns jsonb
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, options, status)
  values (p_workspace, p_lead, p_channel, 'out', 'bot', p_text, p_options, 'queued')
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'text', p_text, 'options', p_options);
end;
$$;

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
declare
  c_handoff_words constant text[] := array['оператор', 'менеджер', 'человек', 'админ', 'администратор', 'operator', 'manager', 'menejer', 'admin'];
  c_handoff_text constant text := 'Передаю ваш вопрос администратору. Он ответит вам здесь.';
  v_channel public.channels;
  v_survey public.surveys;
  v_lead public.leads;
  v_last public.leads;
  v_q public.questions;
  v_next public.questions;
  v_contact_id uuid;
  v_new_contact boolean := false;
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
  v_payload jsonb;
  v_options jsonb;
  v_option jsonb;
  v_answer text;
  v_option_id text;
  v_hint text;
  v_digits text;
  v_stored_text text;
  v_outbound jsonb := '[]'::jsonb;
  v_attempts integer;
  v_number integer;
begin
  select * into v_channel from public.channels where id = p_channel_id and deleted_at is null;
  if not found or not v_channel.is_active then
    return jsonb_build_object('ignored', true);
  end if;

  update public.channels set
    last_event_at = now(),
    status = 'active',
    last_error = null,
    last_error_at = null
  where id = v_channel.id;

  -- Блокировка строки контакта выстраивает его сообщения в очередь до конца транзакции.
  select id into v_contact_id from public.contacts
  where channel_id = v_channel.id and external_id = p_external_user_id;
  v_new_contact := v_contact_id is null;

  insert into public.contacts (workspace_id, channel_id, external_id, display_name, username, meta)
  values (v_channel.workspace_id, v_channel.id, p_external_user_id, p_display_name, p_username, coalesce(p_contact_meta, '{}'::jsonb))
  on conflict (channel_id, external_id) do update set
    display_name = coalesce(excluded.display_name, public.contacts.display_name),
    username = coalesce(excluded.username, public.contacts.username),
    meta = public.contacts.meta || excluded.meta,
    last_seen_at = now()
  returning id into v_contact_id;

  if p_external_message_id is not null and exists (
    select 1 from public.messages where channel_id = v_channel.id and external_id = p_external_message_id
  ) then
    return jsonb_build_object('duplicate', true);
  end if;

  select * into v_lead from public.leads
  where contact_id = v_contact_id and status in ('collecting', 'new', 'in_work')
  limit 1;

  -- Открытой заявки нет: возобновляем недавно закрытую или начинаем новую.
  if not found then
    select * into v_survey from public.surveys
    where workspace_id = v_channel.workspace_id
      and (id = v_channel.survey_id or (v_channel.survey_id is null and is_default))
    limit 1;

    select * into v_last from public.leads
    where contact_id = v_contact_id
    order by created_at desc limit 1;

    if v_last.id is not null and v_last.closed_at is not null
       and v_last.closed_at > now() - make_interval(hours => coalesce(v_survey.restart_after_hours, 24)) then
      update public.leads set
        status = case when assigned_to is null then 'new' else 'in_work' end,
        closed_at = null
      where id = v_last.id;

      insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, attachment, external_id)
      values (v_channel.workspace_id, v_last.id, v_channel.id, 'in', 'contact', v_text, p_attachment, p_external_message_id);

      return jsonb_build_object('lead_id', v_last.id, 'outbound', '[]'::jsonb, 'new_contact', v_new_contact);
    end if;

    if v_survey.id is not null then
      select * into v_q from public.questions
      where survey_id = v_survey.id
      order by position, created_at, id limit 1;
    end if;

    insert into public.leads (workspace_id, channel_id, contact_id, survey_id, status, current_question_id, completed_at)
    values (
      v_channel.workspace_id, v_channel.id, v_contact_id, v_survey.id,
      case when v_q.id is null then 'new' else 'collecting' end,
      v_q.id,
      case when v_q.id is null then now() end
    )
    returning * into v_lead;

    insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, attachment, external_id)
    values (v_channel.workspace_id, v_lead.id, v_channel.id, 'in', 'contact', v_text, p_attachment, p_external_message_id);

    if v_q.id is not null then
      if nullif(btrim(coalesce(v_survey.welcome_text, '')), '') is not null then
        v_outbound := v_outbound || private.queue_out(v_lead.id, v_channel.workspace_id, v_channel.id, v_survey.welcome_text);
      end if;
      v_payload := private.question_payload(v_q);
      v_outbound := v_outbound || private.queue_out(
        v_lead.id, v_channel.workspace_id, v_channel.id, v_payload ->> 'text', v_payload -> 'options'
      );
    end if;

    return jsonb_build_object('lead_id', v_lead.id, 'outbound', v_outbound, 'new_contact', v_new_contact);
  end if;

  -- Заявка уже у людей: бот молчит, сообщение просто попадает к администратору.
  if v_lead.status <> 'collecting' then
    insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, attachment, external_id)
    values (v_channel.workspace_id, v_lead.id, v_channel.id, 'in', 'contact', v_text, p_attachment, p_external_message_id);
    return jsonb_build_object('lead_id', v_lead.id, 'outbound', '[]'::jsonb, 'new_contact', v_new_contact);
  end if;

  select * into v_q from public.questions where id = v_lead.current_question_id;
  if not found then
    v_q := private.next_question(v_lead.id, v_lead.survey_id);
  end if;

  v_stored_text := coalesce(v_text, case when p_option_id is not null then 'Нажата устаревшая кнопка' end);

  -- Клиент просит живого человека.
  if lower(coalesce(v_text, '')) = any (c_handoff_words) then
    update public.leads set
      status = 'new', handoff = true, current_question_id = null, completed_at = now()
    where id = v_lead.id;
    insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, attachment, external_id)
    values (v_channel.workspace_id, v_lead.id, v_channel.id, 'in', 'contact', v_text, p_attachment, p_external_message_id);
    v_outbound := v_outbound || private.queue_out(v_lead.id, v_channel.workspace_id, v_channel.id, c_handoff_text);
    return jsonb_build_object('lead_id', v_lead.id, 'outbound', v_outbound, 'new_contact', v_new_contact);
  end if;

  if v_q.id is not null then
    v_payload := private.question_payload(v_q);
    v_options := v_payload -> 'options';

    if lower(coalesce(v_text, '')) like '/start%' then
      v_hint := '';
    elsif v_text is null and p_option_id is null then
      v_hint := 'Пока я понимаю только текст.';
    else
      -- Кнопка или текст совпали с вариантом ответа?
      if p_option_id is not null then
        select o into v_option from jsonb_array_elements(v_options) o where o ->> 'id' = p_option_id limit 1;
      end if;
      if v_option is null and v_text is not null then
        select o into v_option from jsonb_array_elements(v_options) o
        where lower(btrim(o ->> 'label')) = lower(v_text) limit 1;
      end if;
      -- Номер варианта считается только в вопросах с выбором: в текстовом «1» это ответ.
      if v_option is null and v_q.type = 'choice' and v_text ~ '^[0-9]{1,2}[.)]?$' then
        v_number := (regexp_match(v_text, '^([0-9]{1,2})'))[1]::integer;
        if v_number between 1 and jsonb_array_length(v_options) then
          v_option := v_options -> (v_number - 1);
        end if;
      end if;

      if v_option is not null then
        v_option_id := v_option ->> 'id';
        v_stored_text := v_option ->> 'label';
        v_answer := case when v_option_id = 'skip' then null else v_option ->> 'label' end;
      elsif v_q.type = 'choice' then
        if v_q.allow_other and v_text is not null then
          v_answer := left(v_text, 2000);
        else
          v_hint := 'Выберите один из вариантов.';
        end if;
      elsif v_q.type = 'phone' then
        v_digits := regexp_replace(coalesce(v_text, ''), '[^0-9]', '', 'g');
        if v_text ~ '^[+0-9 ()\-.]+$' and length(v_digits) between 7 and 15 then
          v_answer := case when v_text like '+%' then '+' else '' end || v_digits;
          update public.contacts set phone = v_answer where id = v_contact_id;
        else
          v_hint := 'Похоже, в номере ошибка. Напишите его цифрами, например +998 90 123 45 67.';
        end if;
      else
        if v_text is null then
          v_hint := 'Напишите ответ текстом.';
        else
          v_answer := left(v_text, 2000);
        end if;
      end if;
    end if;

    if v_hint is not null then
      -- /start просто повторяет вопрос и не считается ошибкой. После трёх ошибок зовём человека.
      insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, attachment, external_id)
      values (v_channel.workspace_id, v_lead.id, v_channel.id, 'in', 'contact', v_stored_text, p_attachment, p_external_message_id);

      v_attempts := v_lead.invalid_attempts + case when v_hint = '' then 0 else 1 end;
      if v_attempts >= 3 then
        update public.leads set
          status = 'new', handoff = true, current_question_id = null, completed_at = now(), invalid_attempts = v_attempts
        where id = v_lead.id;
        v_outbound := v_outbound || private.queue_out(v_lead.id, v_channel.workspace_id, v_channel.id, c_handoff_text);
      else
        update public.leads set invalid_attempts = v_attempts, current_question_id = v_q.id where id = v_lead.id;
        v_outbound := v_outbound || private.queue_out(
          v_lead.id, v_channel.workspace_id, v_channel.id,
          case when v_hint = '' then v_payload ->> 'text' else v_hint || E'\n\n' || (v_payload ->> 'text') end,
          v_options
        );
      end if;
      return jsonb_build_object('lead_id', v_lead.id, 'outbound', v_outbound, 'new_contact', v_new_contact);
    end if;

    insert into public.answers (workspace_id, lead_id, question_id, question_text, position, answer_text, option_id)
    values (v_channel.workspace_id, v_lead.id, v_q.id, v_q.text, v_q.position, v_answer, v_option_id)
    on conflict (lead_id, question_id) do update set
      answer_text = excluded.answer_text, option_id = excluded.option_id;
  end if;

  insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, attachment, external_id)
  values (v_channel.workspace_id, v_lead.id, v_channel.id, 'in', 'contact', v_stored_text, p_attachment, p_external_message_id);

  v_next := private.next_question(v_lead.id, v_lead.survey_id);

  if v_next.id is not null then
    update public.leads set current_question_id = v_next.id, invalid_attempts = 0 where id = v_lead.id;
    v_payload := private.question_payload(v_next);
    v_outbound := v_outbound || private.queue_out(
      v_lead.id, v_channel.workspace_id, v_channel.id, v_payload ->> 'text', v_payload -> 'options'
    );
  else
    update public.leads set
      status = 'new', current_question_id = null, completed_at = now(), invalid_attempts = 0
    where id = v_lead.id;
    select * into v_survey from public.surveys where id = v_lead.survey_id;
    if nullif(btrim(coalesce(v_survey.completion_text, '')), '') is not null then
      v_outbound := v_outbound || private.queue_out(v_lead.id, v_channel.workspace_id, v_channel.id, v_survey.completion_text);
    end if;
  end if;

  return jsonb_build_object('lead_id', v_lead.id, 'outbound', v_outbound, 'new_contact', v_new_contact);
end;
$$;

-- Владелец сам написал клиенту из своего Telegram: фиксируем это и останавливаем бота.
create function public.bot_record_owner_message(
  p_channel_id uuid, p_external_user_id text, p_external_message_id text, p_text text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lead public.leads;
begin
  select l.* into v_lead from public.leads l
  join public.contacts c on c.id = l.contact_id
  where c.channel_id = p_channel_id and c.external_id = p_external_user_id
    and l.status in ('collecting', 'new', 'in_work')
  limit 1
  for update of l;

  if not found then
    return jsonb_build_object('ignored', true);
  end if;

  if p_external_message_id is not null and exists (
    select 1 from public.messages where channel_id = p_channel_id and external_id = p_external_message_id
  ) then
    return jsonb_build_object('duplicate', true);
  end if;

  update public.leads set
    status = 'in_work',
    current_question_id = null,
    completed_at = coalesce(completed_at, now()),
    taken_at = coalesce(taken_at, now())
  where id = v_lead.id;

  insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, external_id, status)
  values (v_lead.workspace_id, v_lead.id, p_channel_id, 'out', 'agent', p_text, p_external_message_id, 'sent');

  return jsonb_build_object('lead_id', v_lead.id);
end;
$$;

-- p_channel_error: проблема всего канала (токен, права), а не одного клиента (заблокировал бота, окно 24 часа).
create function public.bot_message_result(
  p_message_id uuid, p_external_id text default null, p_error text default null, p_channel_error boolean default false
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_channel uuid;
begin
  update public.messages set
    status = case when p_error is null then 'sent' else 'failed' end,
    external_id = coalesce(p_external_id, external_id),
    error = p_error
  where id = p_message_id
  returning channel_id into v_channel;

  if p_error is not null and p_channel_error then
    update public.channels set last_error = left(p_error, 500), last_error_at = now() where id = v_channel;
  elsif p_error is null then
    update public.channels set last_error = null, last_error_at = null
    where id = v_channel and last_error is not null;
  end if;
end;
$$;

-- Ответ администратора: заявка закрепляется за ним, бот замолкает.
create function public.agent_queue_message(p_lead_id uuid, p_agent_id uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lead public.leads;
  v_contact public.contacts;
  v_id uuid;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found or not exists (
    select 1 from public.workspace_members where workspace_id = v_lead.workspace_id and user_id = p_agent_id
  ) then
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

-- ---------------------------------------------------------------------------
-- Действия администратора из браузера
-- ---------------------------------------------------------------------------

create function public.take_lead(p_lead_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lead public.leads;
  v_holder text;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found or not private.is_member(v_lead.workspace_id) then
    raise exception 'Заявка не найдена' using errcode = '42501';
  end if;

  if v_lead.status = 'in_work' and v_lead.assigned_to is not null and v_lead.assigned_to <> auth.uid() then
    select email into v_holder from public.workspace_members
    where workspace_id = v_lead.workspace_id and user_id = v_lead.assigned_to;
    raise exception 'Заявку уже взял в работу %', coalesce(v_holder, 'другой администратор') using errcode = 'P0001';
  end if;

  begin
    update public.leads set
      status = 'in_work',
      assigned_to = auth.uid(),
      taken_at = coalesce(taken_at, now()),
      completed_at = coalesce(completed_at, now()),
      current_question_id = null,
      closed_at = null,
      unread_count = 0
    where id = p_lead_id;
  exception when unique_violation then
    raise exception 'У этого клиента уже есть открытая заявка' using errcode = 'P0001';
  end;
end;
$$;

create function public.set_lead_status(p_lead_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lead public.leads;
begin
  if p_status not in ('new', 'in_work', 'done', 'rejected') then
    raise exception 'Неизвестный статус' using errcode = '22023';
  end if;

  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found or not private.is_member(v_lead.workspace_id) then
    raise exception 'Заявка не найдена' using errcode = '42501';
  end if;

  begin
    update public.leads set
      status = p_status,
      current_question_id = null,
      completed_at = coalesce(completed_at, now()),
      assigned_to = case
        when p_status = 'new' then null
        when p_status = 'in_work' then coalesce(assigned_to, auth.uid())
        else assigned_to end,
      taken_at = case when p_status = 'new' then null else taken_at end,
      closed_at = case when p_status in ('done', 'rejected') then now() end,
      unread_count = case when p_status in ('done', 'rejected') then 0 else unread_count end
    where id = p_lead_id;
  exception when unique_violation then
    raise exception 'У этого клиента уже есть открытая заявка' using errcode = 'P0001';
  end;
end;
$$;

create function public.mark_lead_read(p_lead_id uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.leads set unread_count = 0
  where id = p_lead_id and private.is_member(workspace_id);
$$;

create function public.set_lead_note(p_lead_id uuid, p_note text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.leads set note = left(p_note, 4000)
  where id = p_lead_id and private.is_member(workspace_id);
$$;

create function public.set_default_survey(p_survey_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_workspace uuid;
begin
  select workspace_id into v_workspace from public.surveys where id = p_survey_id;
  if v_workspace is null or not private.is_owner(v_workspace) then
    raise exception 'Опрос не найден' using errcode = '42501';
  end if;
  update public.surveys set is_default = false where workspace_id = v_workspace and is_default;
  update public.surveys set is_default = true where id = p_survey_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.surveys enable row level security;
alter table public.questions enable row level security;
alter table public.channels enable row level security;
alter table public.channel_secrets enable row level security;
alter table public.contacts enable row level security;
alter table public.leads enable row level security;
alter table public.answers enable row level security;
alter table public.messages enable row level security;

create policy workspaces_select on public.workspaces for select to authenticated
  using (private.is_member(id));
create policy workspaces_update on public.workspaces for update to authenticated
  using (private.is_owner(id)) with check (private.is_owner(id));

create policy members_select on public.workspace_members for select to authenticated
  using (private.is_member(workspace_id));

create policy surveys_select on public.surveys for select to authenticated
  using (private.is_member(workspace_id));
create policy surveys_insert on public.surveys for insert to authenticated
  with check (private.is_owner(workspace_id));
create policy surveys_update on public.surveys for update to authenticated
  using (private.is_owner(workspace_id)) with check (private.is_owner(workspace_id));
create policy surveys_delete on public.surveys for delete to authenticated
  using (private.is_owner(workspace_id) and not is_default);

create policy questions_select on public.questions for select to authenticated
  using (exists (select 1 from public.surveys s where s.id = survey_id and private.is_member(s.workspace_id)));
create policy questions_insert on public.questions for insert to authenticated
  with check (exists (select 1 from public.surveys s where s.id = survey_id and private.is_owner(s.workspace_id)));
create policy questions_update on public.questions for update to authenticated
  using (exists (select 1 from public.surveys s where s.id = survey_id and private.is_owner(s.workspace_id)))
  with check (exists (select 1 from public.surveys s where s.id = survey_id and private.is_owner(s.workspace_id)));
create policy questions_delete on public.questions for delete to authenticated
  using (exists (select 1 from public.surveys s where s.id = survey_id and private.is_owner(s.workspace_id)));

create policy channels_select on public.channels for select to authenticated
  using (private.is_member(workspace_id));
create policy channels_update on public.channels for update to authenticated
  using (private.is_owner(workspace_id))
  with check (
    private.is_owner(workspace_id)
    and (survey_id is null or exists (
      select 1 from public.surveys s where s.id = survey_id and s.workspace_id = channels.workspace_id
    ))
  );

create policy contacts_select on public.contacts for select to authenticated
  using (private.is_member(workspace_id));
create policy leads_select on public.leads for select to authenticated
  using (private.is_member(workspace_id));
create policy answers_select on public.answers for select to authenticated
  using (private.is_member(workspace_id));
create policy messages_select on public.messages for select to authenticated
  using (private.is_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Права. Supabase по умолчанию выдаёт anon и authenticated всё на новые объекты,
-- поэтому сначала забираем, затем выдаём только нужное.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated, public;
revoke all on all functions in schema public from anon, authenticated, public;
revoke all on all functions in schema private from anon, public;

grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;

grant select on
  public.workspaces, public.workspace_members, public.surveys, public.questions,
  public.channels, public.contacts, public.leads, public.answers, public.messages
to authenticated;

grant insert, update, delete on public.surveys, public.questions to authenticated;
grant update (name) on public.workspaces to authenticated;
grant update (name, survey_id, is_active) on public.channels to authenticated;

grant execute on function
  public.take_lead(uuid),
  public.set_lead_status(uuid, text),
  public.mark_lead_read(uuid),
  public.set_lead_note(uuid, text),
  public.set_default_survey(uuid)
to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: новые заявки и сообщения появляются на сайте без перезагрузки.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.leads, public.messages, public.answers;
  end if;
end;
$$;
