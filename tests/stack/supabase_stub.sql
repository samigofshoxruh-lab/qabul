-- Минимальная копия окружения Supabase для локальных тестов:
-- роли, схема auth и те же права по умолчанию на новые объекты.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit password 'authenticator';
grant anon, authenticated, service_role to authenticator;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create role supabase_auth_admin nologin noinherit;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
grant usage on schema auth to supabase_auth_admin;
grant all on auth.users to supabase_auth_admin;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create publication supabase_realtime;
