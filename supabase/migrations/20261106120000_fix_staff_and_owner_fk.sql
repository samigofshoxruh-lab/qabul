-- Supabase Auth записывает app_metadata уже после вставки пользователя, поэтому триггер
-- не видел приглашение и сотрудник не попадал в кабинет. Теперь его добавляет функция team.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists private.handle_new_user();

-- Удаление учётной записи владельца не должно стирать всю компанию.
-- Компанию удаляет только главный админ отдельным действием.
alter table public.workspaces alter column owner_id drop not null;
alter table public.workspaces drop constraint workspaces_owner_id_fkey;
alter table public.workspaces
  add constraint workspaces_owner_id_fkey
  foreign key (owner_id) references auth.users (id) on delete set null;
