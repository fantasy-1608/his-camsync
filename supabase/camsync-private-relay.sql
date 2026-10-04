-- Apply only to the verified existing his-camsync project.
-- User accepted shared organization quota; CamSync has its own application budget.
-- No image, HIS identifiers, patient information, E2EE key or raw pairing secret is stored.
do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'realtime') then raise exception 'Realtime schema missing'; end if;
end $$;
create schema if not exists camsync_private;
revoke all on schema camsync_private from public, anon, authenticated;
grant usage on schema camsync_private to service_role;
create table if not exists camsync_private.sessions (
  sid text primary key check (sid ~ '^[a-f0-9]{32}$'),
  generation bigint not null check (generation > 0),
  desktop_hash text not null check (desktop_hash ~ '^[a-f0-9]{64}$'),
  mobile_hash text not null check (mobile_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '5 minutes',
  revoked boolean not null default false,
  grant_count integer not null default 0
);
alter table camsync_private.sessions enable row level security;
revoke all on camsync_private.sessions from public, anon, authenticated;
grant select, insert, update, delete on camsync_private.sessions to service_role;

create table if not exists camsync_private.monthly_usage (
 period date primary key,
 reserved_bytes bigint not null default 0 check (reserved_bytes >= 0)
);
create table if not exists camsync_private.transfer_reservations (
 sid text not null references camsync_private.sessions(sid) on delete cascade,
 transfer_id text not null,
 bytes bigint not null,
 primary key(sid,transfer_id)
);
alter table camsync_private.monthly_usage enable row level security;
alter table camsync_private.transfer_reservations enable row level security;
revoke all on camsync_private.monthly_usage, camsync_private.transfer_reservations from public,anon,authenticated;
grant select,insert,update,delete on camsync_private.monthly_usage,camsync_private.transfer_reservations to service_role;

create or replace function public.camsync_authorize_session(
 p_action text, p_sid text, p_generation bigint, p_role text, p_capability_hash text, p_mobile_hash text default null,
 p_transfer_id text default null, p_bytes bigint default 0, p_budget bigint default 250000000
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s camsync_private.sessions%rowtype;
 period_start date := date_trunc('month', now() at time zone 'UTC')::date;
 used_bytes bigint; old_bytes bigint;
begin
  if p_sid is null or p_generation is null or p_role is null or p_action is null or p_capability_hash is null or p_sid !~ '^[a-f0-9]{32}$' or p_capability_hash !~ '^[a-f0-9]{64}$' or p_generation < 1 or p_role not in ('desktop','mobile') or p_action not in ('create','join','revoke','reserve') then raise exception 'INVALID_REQUEST'; end if;
  perform pg_advisory_xact_lock(715251);
  delete from camsync_private.sessions where created_at < now() - interval '1 day';
  if p_budget is null or p_budget < 65536 or p_budget > 500000000 then raise exception 'INVALID_BUDGET'; end if;
  insert into camsync_private.monthly_usage(period) values(period_start) on conflict do nothing;
  select reserved_bytes into used_bytes from camsync_private.monthly_usage where period=period_start for update;
  if p_action = 'create' then
    if p_role <> 'desktop' or p_mobile_hash is null or p_mobile_hash !~ '^[a-f0-9]{64}$' or p_mobile_hash = p_capability_hash then raise exception 'INVALID_REQUEST'; end if;
    if not exists(select 1 from camsync_private.sessions where sid=p_sid) and (select count(*) from camsync_private.sessions) >= 500 then raise exception 'SESSION_LIMIT'; end if;
    if not exists(select 1 from camsync_private.sessions where sid=p_sid) then
      if used_bytes + 65536 > p_budget then raise exception 'BUDGET_EXHAUSTED'; end if;
      update camsync_private.monthly_usage set reserved_bytes=reserved_bytes+65536 where period=period_start;
      used_bytes := used_bytes + 65536;
    end if;
    insert into camsync_private.sessions(sid,generation,desktop_hash,mobile_hash) values(p_sid,p_generation,p_capability_hash,p_mobile_hash) on conflict(sid) do nothing;
  end if;
  select * into s from camsync_private.sessions where sid=p_sid for update;
  if not found or s.generation <> p_generation or s.revoked or s.expires_at <= now() or (case when p_role='desktop' then s.desktop_hash else s.mobile_hash end) <> p_capability_hash then raise exception 'SESSION_UNAVAILABLE'; end if;
  if p_action='create' and s.mobile_hash <> p_mobile_hash then raise exception 'SESSION_UNAVAILABLE'; end if;
  if p_action='revoke' then
    if p_role <> 'desktop' then raise exception 'INVALID_REQUEST'; end if;
    update camsync_private.sessions set revoked=true where sid=p_sid;
    return jsonb_build_object('revoked',true);
  end if;
  if p_action='reserve' then
    if p_role <> 'mobile' or p_transfer_id is null or p_transfer_id !~ '^[A-Za-z0-9_-]{8,128}$' or p_bytes < 1 or p_bytes > 100663296 then raise exception 'INVALID_RESERVATION'; end if;
    select bytes into old_bytes from camsync_private.transfer_reservations where sid=p_sid and transfer_id=p_transfer_id;
    if found then
      if old_bytes <> p_bytes then raise exception 'RESERVATION_CONFLICT'; end if;
      return jsonb_build_object('remaining_bytes',greatest(0,p_budget-used_bytes));
    end if;
    if used_bytes + p_bytes > p_budget then raise exception 'BUDGET_EXHAUSTED'; end if;
    insert into camsync_private.transfer_reservations(sid,transfer_id,bytes) values(p_sid,p_transfer_id,p_bytes);
    update camsync_private.monthly_usage set reserved_bytes=reserved_bytes+p_bytes where period=period_start;
    return jsonb_build_object('remaining_bytes',p_budget-used_bytes-p_bytes);
  end if;
  if s.grant_count >= 40 then raise exception 'GRANT_LIMIT'; end if;
  update camsync_private.sessions set grant_count=grant_count+1 where sid=p_sid;
  return jsonb_build_object('expires_at',s.expires_at);
end $$;
revoke all on function public.camsync_authorize_session(text,text,bigint,text,text,text,text,bigint,bigint) from public, anon, authenticated;
grant execute on function public.camsync_authorize_session(text,text,bigint,text,text,text,text,bigint,bigint) to service_role;

-- SECURITY DEFINER is restricted to this non-exposed schema, fixed search_path,
-- authenticated caller and matching issuer/project/session/generation/topic claims.
create or replace function camsync_private.can_relay() returns boolean
language sql stable security definer set search_path = '' as $$
 select auth.uid() is not null
 and auth.jwt()->>'role'='authenticated'
 and auth.jwt()->>'iss'='https://rmbbqtuzkyxovmskhfgj.supabase.co/auth/v1'
 and auth.jwt()->>'camsync'='true'
 and auth.jwt()->>'camsync_project'='rmbbqtuzkyxovmskhfgj'
 and auth.jwt()->>'camsync_role' in ('desktop','mobile')
 and exists (
   select 1 from camsync_private.sessions s
   where s.sid=auth.jwt()->>'camsync_sid'
   and s.generation::text=auth.jwt()->>'camsync_generation'
   and s.expires_at > now() and not s.revoked
   and realtime.topic()='camsync:private:v1:' || s.sid || ':' || s.generation::text
 );
$$;
revoke all on function camsync_private.can_relay() from public, anon;
grant usage on schema camsync_private to authenticated;
grant execute on function camsync_private.can_relay() to authenticated;
-- realtime.messages already has RLS enabled, verified on the target project.
drop policy if exists camsync_private_receive on realtime.messages;
create policy camsync_private_receive on realtime.messages for select to authenticated
 using (extension='broadcast' and (select camsync_private.can_relay()));
drop policy if exists camsync_private_send on realtime.messages;
create policy camsync_private_send on realtime.messages for insert to authenticated
 with check (extension='broadcast' and (select camsync_private.can_relay()));
