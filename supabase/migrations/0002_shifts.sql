create table shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  client_id uuid not null references clients (id) on delete cascade,
  staff_id uuid references staff (id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'planned' check (status in ('planned', 'done', 'cancelled', 'no_show')),
  price_cents integer not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index shifts_company_starts_idx on shifts (company_id, starts_at);

alter table shifts enable row level security;

create policy "own company reads shifts" on shifts
  for select using (company_id = auth_company_id());

create policy "own company plans shifts" on shifts
  for insert with check (company_id = auth_company_id());

create policy "own company edits shifts" on shifts
  for update using (company_id = auth_company_id()) with check (company_id = auth_company_id());

create policy "own company removes shifts" on shifts
  for delete using (company_id = auth_company_id());
