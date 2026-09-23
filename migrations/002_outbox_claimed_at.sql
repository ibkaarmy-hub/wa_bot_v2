alter table outbound_messages add column if not exists claimed_at timestamptz;
