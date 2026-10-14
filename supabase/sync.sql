-- Синхронізація даних Astra Browser (server/src/sync.rs, client/src/app/browser/sync).
-- Виконати один раз у Supabase: SQL Editor → New query → вставити все → Run. Повторний запуск нічого не ламає.
--
-- Кожен рядок — один запис користувача: закладки, нотатки, історія, налаштування, паролі сайтів (вони приходять уже
-- зашифрованими на комп'ютері ключем із пароля облікового запису — сервер їх прочитати не може).
-- Видалені записи лишаються з deleted = true (без даних — лише id і час), щоб видалення дійшло до інших комп'ютерів,
-- а через 30 днів сервер прибирає їх сам — щодня за розкладом (pg_cron, у кінці файла) і під час синхронізації
-- (sync_push): за цей час видалення встигає дійти до всіх.

create sequence if not exists public.sync_revision;

create table if not exists public.sync_items (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  collection text not null,
  id text not null,
  data jsonb,
  deleted boolean not null default false,
  -- Час зміни на комп'ютері (мс): з двох змін одного запису перемагає пізніша.
  updated_at bigint not null,
  -- Порядковий номер зміни на сервері: комп'ютер забирає все, що новіше за останній відомий йому номер.
  revision bigint not null default nextval('public.sync_revision'),
  primary key (user_id, collection, id)
);

create index if not exists sync_items_user_revision on public.sync_items (user_id, revision);
-- Для прибирання давніх позначок «видалено».
create index if not exists sync_items_user_tombstones on public.sync_items (user_id, updated_at) where deleted;

-- Кожен бачить і змінює лише свої записи.
alter table public.sync_items enable row level security;

drop policy if exists "sync_items: read own" on public.sync_items;
create policy "sync_items: read own" on public.sync_items
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "sync_items: insert own" on public.sync_items;
create policy "sync_items: insert own" on public.sync_items
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "sync_items: update own" on public.sync_items;
create policy "sync_items: update own" on public.sync_items
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "sync_items: delete own" on public.sync_items;
create policy "sync_items: delete own" on public.sync_items
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.sync_items from anon;
grant select, insert, update, delete on public.sync_items to authenticated;
grant usage on sequence public.sync_revision to authenticated;

-- Записи з комп'ютера: новий запис додається, наявний замінюється, лише якщо зміна новіша.
-- Повертає ті, що не прийнято (на сервері новіші), — з версією сервера.
-- Заодно прибирає позначки «видалено» цього користувача, старші за 30 днів.
create or replace function public.sync_push(items jsonb)
returns setof public.sync_items
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.sync_items
  where user_id = auth.uid()
    and deleted
    and updated_at < (extract(epoch from now()) * 1000)::bigint - 30::bigint * 24 * 60 * 60 * 1000;

  return query
  with incoming as (
    select
      item ->> 'collection' as collection,
      item ->> 'id' as id,
      item -> 'data' as data,
      coalesce((item ->> 'deleted')::boolean, false) as deleted,
      (item ->> 'updated_at')::bigint as updated_at
    from jsonb_array_elements(items) as item
  ),
  applied as (
    insert into public.sync_items as existing (user_id, collection, id, data, deleted, updated_at)
    select auth.uid(), incoming.collection, incoming.id, incoming.data, incoming.deleted, incoming.updated_at
    from incoming
    on conflict (user_id, collection, id) do update
      set data = excluded.data,
          deleted = excluded.deleted,
          updated_at = excluded.updated_at,
          revision = nextval('public.sync_revision')
      where existing.updated_at < excluded.updated_at
    returning existing.collection, existing.id
  )
  select stored.*
  from public.sync_items as stored
  join incoming on incoming.collection = stored.collection and incoming.id = stored.id
  where stored.user_id = auth.uid()
    and not exists (select 1 from applied where applied.collection = stored.collection and applied.id = stored.id);
end;
$$;

revoke execute on function public.sync_push(jsonb) from public, anon;
grant execute on function public.sync_push(jsonb) to authenticated;

-- Прибирання за розкладом: позначки «видалено», старші за 30 днів, — щодня в усіх користувачів, і в тих, хто більше не
-- запускає браузер (sync_push прибирає лише свої й лише під час синхронізації). Розклад — розширення pg_cron (у Supabase
-- його можна ввімкнути й у Integrations → Cron). Задача з тією самою назвою замінюється, тож повторний запуск файла її
-- не дублює. Час — UTC.
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'sync-items-tombstones',
  '17 3 * * *',
  $$
    delete from public.sync_items
    where deleted
      and updated_at < (extract(epoch from now()) * 1000)::bigint - 30::bigint * 24 * 60 * 60 * 1000
  $$
);
