create table payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  stripe_session_id text not null unique,
  amount_cents integer not null,
  status text not null,
  created_at timestamptz not null default now()
);

alter table payments enable row level security;

create policy "own company reads payments" on payments
  for select using (company_id = auth_company_id());

create table invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  client_id uuid not null references clients (id) on delete cascade,
  number text not null,
  amount_cents integer not null,
  due_on date not null,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, number)
);

alter table invoices enable row level security;

create policy "own company reads invoices" on invoices
  for select using (company_id = auth_company_id());

create policy "own company writes invoices" on invoices
  for all using (company_id = auth_company_id()) with check (company_id = auth_company_id());
