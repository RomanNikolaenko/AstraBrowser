-- Видалення облікового запису Astra Browser (server/src/auth.rs, auth_delete_account).
-- Виконати один раз у Supabase: SQL Editor → New query → вставити все → Run. Повторний запуск нічого не ламає.
--
-- Видалити користувача може лише сервер із секретним ключем Supabase, а його в застосунку бути не повинно. Тож
-- видаляє ця функція бази: вона виконується з правами свого власника (security definer), але видаляє лише того,
-- хто її викликав, і лише якщо він щойно ввів пароль. Коли саме сервер перевірив пароль, Supabase пише в токен
-- входу (JWT, поле amr), а застосунок перед видаленням входить із паролем наново.
--
-- Разом із користувачем база видаляє його сеанси на всіх пристроях і всі записи синхронізації
-- (sync_items: on delete cascade).

-- Чи може власник функції (той, хто виконує цей SQL) видаляти користувачів — інакше функція не працюватиме.
do $$
begin
  if not has_table_privilege('auth.users', 'delete') then
    raise exception 'Роль % не може видаляти записи з auth.users, тож видалення облікового запису не працюватиме.', current_user;
  end if;
end;
$$;

create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  account uuid := auth.uid();
  password_checked_at bigint;
begin
  if account is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;

  -- Пароль мають перевірити не раніше ніж 10 хвилин тому: украдений давній токен обліковий запис не видалить.
  select max((entry ->> 'timestamp')::bigint)
  into password_checked_at
  from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) as entry
  where entry ->> 'method' = 'password';

  if password_checked_at is null or password_checked_at < extract(epoch from now())::bigint - 600 then
    raise exception 'reauthentication_needed' using errcode = '28000';
  end if;

  delete from auth.users where id = account;
end;
$$;

revoke execute on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
