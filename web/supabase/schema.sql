-- XR-Objects web demo — Supabase schema
--
-- This mirrors the tables that are provisioned in the `xr-objects` Supabase
-- project (ref zufvcxligbyjouypnsul, ap-southeast-1). It is idempotent: running
-- it again on an existing project is a no-op.
--
-- The web demo is an anonymous research prototype, so every table below has
-- RLS enabled with an open policy for `anon` / `authenticated`. Tighten the
-- policies (scope by auth.uid() or a session token) before storing anything
-- that is not throw-away demo data.

create extension if not exists "pgcrypto";

-- One row per visit / AR session. `device` is a coarse label
-- ("Android · Chrome"), the user agent is kept verbatim for debugging.
create table if not exists public.sessions (
  id          uuid primary key default gen_random_uuid(),
  device      text,
  user_agent  text,
  created_at  timestamptz not null default now()
);

-- One row per detected or manually registered real-world object.
--   label      MediaPipe/COCO-ish class, e.g. "cup"
--   category   coarse group, e.g. "drinkware"
--   bbox       normalized { x, y, w, h } in 0..1 screen space
--   source     detector | longpress | circle  (manual registration modes)
--   metadata   Gemini label + extras, e.g. { name, description, thumbnail }
create table if not exists public.objects (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid references public.sessions (id) on delete cascade,
  label       text not null,
  category    text,
  confidence  numeric,
  bbox        jsonb,
  source      text default 'detector',
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists objects_session_idx on public.objects (session_id, created_at);

-- Spatial notes written by the user and anchored to an object.
create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  object_id   uuid references public.objects (id) on delete cascade,
  body        text not null,
  anchor      jsonb,
  created_at  timestamptz not null default now()
);

-- Countdown / stopwatch timers started from an object's context menu.
create table if not exists public.timers (
  id                uuid primary key default gen_random_uuid(),
  object_id         uuid references public.objects (id) on delete cascade,
  kind              text default 'countdown' check (kind in ('countdown', 'stopwatch')),
  duration_seconds  integer,
  started_at        timestamptz default now(),
  finished_at       timestamptz
);

-- "save for later" targets.
create table if not exists public.saved_items (
  id          uuid primary key default gen_random_uuid(),
  object_id   uuid references public.objects (id) on delete cascade,
  label       text,
  list        text default 'default',
  created_at  timestamptz not null default now()
);

-- Audit log of every context-menu action (info, ask, compare, note, ...).
create table if not exists public.object_actions (
  id          uuid primary key default gen_random_uuid(),
  object_id   uuid references public.objects (id) on delete cascade,
  session_id  uuid references public.sessions (id) on delete cascade,
  action      text not null,
  input       text,
  output      text,
  payload     jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists object_actions_session_idx on public.object_actions (session_id, created_at desc);

-- Read-only feed used by the "scene log" panel.
create or replace view public.object_feed as
select
  o.id,
  o.label,
  o.category,
  o.confidence,
  o.source,
  o.created_at,
  count(a.id) as action_count
from public.objects o
left join public.object_actions a on a.object_id = o.id
group by o.id, o.label, o.category, o.confidence, o.source, o.created_at;

-- ------------------------------------------------------------------ RLS
alter table public.sessions       enable row level security;
alter table public.objects        enable row level security;
alter table public.notes          enable row level security;
alter table public.timers         enable row level security;
alter table public.saved_items    enable row level security;
alter table public.object_actions enable row level security;

drop policy if exists sessions_demo_all       on public.sessions;
drop policy if exists objects_demo_all        on public.objects;
drop policy if exists notes_demo_all          on public.notes;
drop policy if exists timers_demo_all         on public.timers;
drop policy if exists saved_items_demo_all    on public.saved_items;
drop policy if exists object_actions_demo_all on public.object_actions;

create policy sessions_demo_all       on public.sessions       for all to anon, authenticated using (true) with check (true);
create policy objects_demo_all        on public.objects        for all to anon, authenticated using (true) with check (true);
create policy notes_demo_all          on public.notes          for all to anon, authenticated using (true) with check (true);
create policy timers_demo_all         on public.timers         for all to anon, authenticated using (true) with check (true);
create policy saved_items_demo_all    on public.saved_items    for all to anon, authenticated using (true) with check (true);
create policy object_actions_demo_all on public.object_actions for all to anon, authenticated using (true) with check (true);
