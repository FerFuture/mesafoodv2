-- MesaFood v2 — esquema para un proyecto de Supabase NUEVO.
-- No lo ejecutes en la base de Illimani.
--
-- Un solo proyecto, varios locales. Cada local es una fila de restaurants.
-- El personal vive en dashboard_users con restaurant_id.
-- La cuenta de control (la tuya) vive en platform_owners y no pertenece a un local.
-- Corré este archivo una vez en Supabase → SQL Editor.

create extension if not exists pgcrypto;

-- ---------- restaurants ----------
create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  public_name text,
  whatsapp_number text,
  opening_hours text,
  address text,
  delivery_zones text,
  policies text,
  metadata jsonb not null default '{}'::jsonb,
  delivery_enabled boolean not null default true,
  local_enabled boolean not null default true,
  mesa_enabled boolean not null default true,
  cash_enabled boolean not null default true,
  mercadopago_enabled boolean not null default true,
  stats_enabled boolean not null default true,
  table_count integer not null default 12,
  status text not null default 'active' check (status in ('active', 'paused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.restaurants
  add column if not exists public_name text,
  add column if not exists address text,
  add column if not exists delivery_zones text,
  add column if not exists policies text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists delivery_enabled boolean not null default true,
  add column if not exists local_enabled boolean not null default true,
  add column if not exists mesa_enabled boolean not null default true,
  add column if not exists cash_enabled boolean not null default true,
  add column if not exists mercadopago_enabled boolean not null default true,
  add column if not exists stats_enabled boolean not null default true,
  add column if not exists table_count integer not null default 12,
  add column if not exists status text not null default 'active',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists restaurants_whatsapp_number_unique
  on public.restaurants (whatsapp_number)
  where whatsapp_number is not null and btrim(whatsapp_number) <> '';

-- ---------- menu ----------
create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  description text,
  price numeric(12,2) not null default 0,
  category text,
  tags text[] not null default '{}',
  available boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists menu_items_restaurant_id_idx on public.menu_items (restaurant_id);

-- ---------- usuarios del local ----------
create table if not exists public.dashboard_users (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  username text not null,
  password_hash text not null,
  role text not null check (role in ('admin', 'encargado', 'delivery', 'kitchen', 'waiter')),
  label text,
  is_active boolean not null default true,
  delivery_work_weekdays integer[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.dashboard_users
  add column if not exists restaurant_id uuid references public.restaurants(id) on delete cascade,
  add column if not exists delivery_work_weekdays integer[],
  add column if not exists label text,
  add column if not exists is_active boolean not null default true,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists dashboard_users_username_lower_idx
  on public.dashboard_users (lower(username));

create index if not exists dashboard_users_restaurant_id_idx
  on public.dashboard_users (restaurant_id);

-- ---------- cuenta de control (dueño de la plataforma) ----------
create table if not exists public.platform_owners (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  password_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists platform_owners_username_lower_idx
  on public.platform_owners (lower(username));

create or replace function public.create_platform_owner(p_username text, p_password_hash text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  uname text;
begin
  uname := lower(btrim(coalesce(p_username, '')));
  if uname !~ '^[a-z0-9._-]{3,40}$' then
    raise exception 'Usuario inválido';
  end if;
  if p_password_hash is null or length(p_password_hash) < 20 then
    raise exception 'Contraseña inválida';
  end if;
  if exists (select 1 from public.platform_owners) then
    raise exception 'Ya existe una cuenta de control';
  end if;
  insert into public.platform_owners (username, password_hash)
  values (uname, p_password_hash)
  returning id into new_id;
  return new_id;
end;
$$;

revoke all on function public.create_platform_owner(text, text) from public;
grant execute on function public.create_platform_owner(text, text) to anon, authenticated;

-- ---------- pedidos ----------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  customer_number text,
  customer_phone text,
  customer_chat_id text,
  bot_number text,
  items jsonb not null default '[]'::jsonb,
  address text,
  notes text,
  observacion text,
  status text not null default 'pending',
  payment_method text,
  payment_status text,
  payment_link text,
  payment_paid_at timestamptz,
  mp_payment_id text,
  total_price numeric(12,2),
  total_amount numeric(12,2),
  subtotal_amount numeric(12,2),
  delivery_fee numeric(12,2),
  final_total_amount numeric(12,2),
  fulfillment_type text,
  table_number integer,
  kitchen_ready_at timestamptz,
  customer_notified_at timestamptz,
  delivery_total_confirmed_at timestamptz,
  delivery_denial_reason text,
  delivery_ready_broadcast_at timestamptz,
  delivery_claimed_by_user_id uuid references public.dashboard_users(id) on delete set null,
  delivery_claimed_at timestamptz,
  delivery_issue_reported_at timestamptz,
  delivery_issue_reason text,
  delivery_issue_reported_by_user_id uuid references public.dashboard_users(id) on delete set null,
  delivery_en_route_customer_notified_at timestamptz,
  delivery_issue_acknowledged_at timestamptz,
  pickup_ready_notify_requested_at timestamptz,
  pickup_ready_customer_notified_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  raw_request text,
  created_at timestamptz not null default now()
);

create index if not exists orders_restaurant_id_created_at_idx
  on public.orders (restaurant_id, created_at desc);

-- ---------- historial del bot (queda listo; el bot no se despliega ahora) ----------
create table if not exists public.bot_interactions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references public.restaurants(id) on delete cascade,
  customer_number text,
  bot_number text,
  message_type text,
  user_message text,
  bot_response text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists bot_interactions_restaurant_customer_idx
  on public.bot_interactions (restaurant_id, customer_number, created_at desc);

-- ---------- stock ----------
create table if not exists public.stock_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  current_stock numeric not null default 0 check (current_stock >= 0),
  unit text not null default 'UNIDAD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, name)
);

create table if not exists public.stock_recipes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  preparation text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, name)
);

create table if not exists public.stock_recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.stock_recipes(id) on delete cascade,
  ingredient_name text not null,
  quantity numeric not null default 1 check (quantity > 0),
  unit text not null default 'UNIDAD',
  created_at timestamptz not null default now(),
  unique (recipe_id, ingredient_name)
);

-- ---------- permisos ----------
grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on table public.restaurants to anon, authenticated;
grant select, insert, update, delete on table public.menu_items to anon, authenticated;
grant select, insert, update, delete on table public.orders to anon, authenticated;
grant select, insert, update, delete on table public.bot_interactions to anon, authenticated;
grant select, insert, update, delete on table public.dashboard_users to anon, authenticated;
grant select on table public.platform_owners to anon, authenticated;
grant select, insert, update, delete on table public.stock_items to anon, authenticated;
grant select, insert, update, delete on table public.stock_recipes to anon, authenticated;
grant select, insert, update, delete on table public.stock_recipe_ingredients to anon, authenticated;

-- El panel entra con usuario y contraseña propios, no con Supabase Auth.
-- La clave anónima necesita leer y escribir estas tablas. El panel filtra por restaurante.
alter table public.restaurants enable row level security;
alter table public.menu_items enable row level security;
alter table public.orders enable row level security;
alter table public.bot_interactions enable row level security;
alter table public.dashboard_users enable row level security;
alter table public.platform_owners enable row level security;
alter table public.stock_items enable row level security;
alter table public.stock_recipes enable row level security;
alter table public.stock_recipe_ingredients enable row level security;

drop policy if exists "mf2_restaurants_all" on public.restaurants;
create policy "mf2_restaurants_all" on public.restaurants for all to anon, authenticated using (true) with check (true);

drop policy if exists "mf2_menu_all" on public.menu_items;
create policy "mf2_menu_all" on public.menu_items for all to anon, authenticated using (true) with check (true);

drop policy if exists "mf2_orders_all" on public.orders;
create policy "mf2_orders_all" on public.orders for all to anon, authenticated using (true) with check (true);

drop policy if exists "mf2_interactions_all" on public.bot_interactions;
create policy "mf2_interactions_all" on public.bot_interactions for all to anon, authenticated using (true) with check (true);

drop policy if exists "mf2_users_all" on public.dashboard_users;
create policy "mf2_users_all" on public.dashboard_users for all to anon, authenticated using (true) with check (true);

drop policy if exists "mf2_owners_select" on public.platform_owners;
create policy "mf2_owners_select" on public.platform_owners for select to anon, authenticated using (true);

drop policy if exists "mf2_stock_items_all" on public.stock_items;
create policy "mf2_stock_items_all" on public.stock_items for all to anon, authenticated using (true) with check (true);

drop policy if exists "mf2_stock_recipes_all" on public.stock_recipes;
create policy "mf2_stock_recipes_all" on public.stock_recipes for all to anon, authenticated using (true) with check (true);

drop policy if exists "mf2_stock_ingredients_all" on public.stock_recipe_ingredients;
create policy "mf2_stock_ingredients_all" on public.stock_recipe_ingredients for all to anon, authenticated using (true) with check (true);

-- Realtime de pedidos
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table public.orders;
  end if;
end
$$;

alter table public.orders replica identity full;
