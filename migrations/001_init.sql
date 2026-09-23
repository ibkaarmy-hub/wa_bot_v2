create extension if not exists pgcrypto;

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  mode text not null default 'bot' check (mode in ('bot','human','closed')),
  other_count int not null default 0,
  last_patient_at timestamptz,
  last_human_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id bigserial primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('in','out','doctor')),
  text text not null,
  external_id text,
  created_at timestamptz not null default now()
);
create index if not exists messages_conv_idx on messages(conversation_id, id);

create table if not exists inbound_events (
  external_id text primary key,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists outbound_messages (
  id bigserial primary key,
  conversation_id uuid references conversations(id) on delete set null,
  to_phone text not null,
  kind text not null check (kind in ('text','template')),
  body text,
  template text,
  params jsonb,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  external_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists outbound_due_idx on outbound_messages(status, next_attempt_at);

create table if not exists audit_events (
  id bigserial primary key,
  conversation_id uuid,
  type text not null,
  data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_conv_idx on audit_events(conversation_id, id);
