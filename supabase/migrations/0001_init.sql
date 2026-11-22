-- Companies, their staff and their clients.
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'free',
  stripe_customer_id text,
  created_at timestamptz not null default now()
);

alter table companies enable row level security;

-- Households and offices a company cleans.
-- Phone and address are what the crew needs on the day.
create table clients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  full_name text not null,
  phone text,
  address text not null,
  notes text,
  created_at timestamptz not null default now()
);

create index clients_company_id_idx on clients (company_id);

create table staff (
  id uuid primary key references auth.users (id) on delete cascade,
  company_id uuid not null references companies (id) on delete cascade,
  full_name text not null,
  role text not null default 'cleaner' check (role in ('owner', 'manager', 'cleaner')),
  hourly_rate_cents integer not null default 1800,
  created_at timestamptz not null default now()
);

alter table staff enable row level security;

create function auth_company_id() returns uuid
language sql stable security definer set search_path = public
as $$
  select company_id from staff where id = auth.uid()
$$;

create policy "own company reads company" on companies
  for select using (id = auth_company_id());

create policy "own company reads staff" on staff
  for select using (company_id = auth_company_id());
