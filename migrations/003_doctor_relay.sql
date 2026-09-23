alter table conversations add column if not exists code text;
alter table conversations add column if not exists claimed_by text;
alter table conversations add column if not exists handoff_at timestamptz;
alter table conversations add column if not exists realert_count int not null default 0;
create unique index if not exists conversations_code_idx on conversations(code);
create index if not exists conversations_pending_idx on conversations(handoff_at) where mode = 'human' and claimed_by is null and realert_count < 2;

create table if not exists doctor_state (
  doctor_id text primary key,
  active_conversation_id uuid references conversations(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table outbound_messages add column if not exists origin jsonb;

-- Conversations left in human mode by the pre-relay hand-off have no code and no pending state;
-- nobody would ever be re-alerted for them. Hand them back to the bot once.
update conversations set mode = 'bot', other_count = 0 where mode = 'human' and code is null;
