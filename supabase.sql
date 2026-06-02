create extension if not exists pgcrypto;

create table if not exists public.admin_codes (
  id uuid primary key default gen_random_uuid(),
  label text not null default 'Admin',
  code_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.quizzes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text default '',
  host_token text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  question_type text not null default 'multiple_choice' check (question_type in ('multiple_choice', 'free_text', 'image_reveal')),
  body text not null,
  answers jsonb not null,
  image_url text,
  correct_index int not null check (correct_index between 0 and 3),
  duration_seconds int not null default 20 check (duration_seconds between 5 and 120),
  min_points int not null default 50 check (min_points >= 0),
  max_points int not null default 100 check (max_points >= min_points),
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  code text not null,
  host_token text not null,
  status text not null default 'lobby' check (status in ('lobby', 'playing', 'finished')),
  access_enabled boolean not null default true,
  show_answer boolean not null default false,
  show_leaderboard boolean not null default false,
  points_awarded boolean not null default false,
  current_question_index int not null default -1,
  question_started_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.game_players (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  nickname text not null,
  score int not null default 0,
  joined_at timestamptz not null default now()
);

create table if not exists public.game_answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  player_id uuid not null references public.game_players(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  answer_index int check (answer_index between 0 and 9),
  answer_text text,
  is_correct boolean not null default false,
  points int not null default 0,
  answered_at timestamptz not null default now(),
  unique (player_id, question_id)
);

create unique index if not exists game_sessions_active_code_idx
  on public.game_sessions (code)
  where status <> 'finished';

alter table public.questions add column if not exists image_url text;
alter table public.questions add column if not exists question_type text not null default 'multiple_choice';
alter table public.questions drop constraint if exists questions_question_type_check;
alter table public.questions add constraint questions_question_type_check check (question_type in ('multiple_choice', 'free_text', 'image_reveal'));
alter table public.questions drop constraint if exists questions_correct_index_check;
alter table public.questions add constraint questions_correct_index_check check (correct_index between 0 and 9);
alter table public.questions add column if not exists min_points int not null default 50;
alter table public.questions add column if not exists max_points int not null default 100;
alter table public.questions drop constraint if exists questions_min_points_check;
alter table public.questions drop constraint if exists questions_max_points_check;
alter table public.questions add constraint questions_min_points_check check (min_points >= 0);
alter table public.questions add constraint questions_max_points_check check (max_points >= min_points);
alter table public.game_sessions add column if not exists access_enabled boolean not null default true;
alter table public.game_sessions add column if not exists show_answer boolean not null default false;
alter table public.game_sessions add column if not exists show_leaderboard boolean not null default false;
alter table public.game_sessions add column if not exists points_awarded boolean not null default false;
alter table public.game_answers add column if not exists answer_text text;
alter table public.game_answers alter column answer_index drop not null;
alter table public.game_answers drop constraint if exists game_answers_answer_index_check;
alter table public.game_answers add constraint game_answers_answer_index_check check (answer_index between 0 and 9);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'question-images',
  'question-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.verify_admin_code(admin_code_input text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_codes
    where is_active = true
      and code_hash = extensions.crypt(admin_code_input, code_hash)
  );
$$;

create or replace function public.enforce_question_limit()
returns trigger
language plpgsql
as $$
begin
  if (
    select count(*)
    from public.questions
    where quiz_id = new.quiz_id
  ) >= 20 then
    raise exception 'Un quiz ne peut pas depasser 20 questions.';
  end if;

  return new;
end;
$$;

drop trigger if exists questions_limit_before_insert on public.questions;
create trigger questions_limit_before_insert
before insert on public.questions
for each row execute function public.enforce_question_limit();

create or replace function public.increment_player_score(player_id_input uuid, points_input int)
returns void
language sql
as $$
  update public.game_players
  set score = score + points_input
  where id = player_id_input;
$$;

alter table public.admin_codes enable row level security;
alter table public.quizzes enable row level security;
alter table public.questions enable row level security;
alter table public.game_sessions enable row level security;
alter table public.game_players enable row level security;
alter table public.game_answers enable row level security;

drop policy if exists "public read admin codes" on public.admin_codes;
drop policy if exists "public read question images" on storage.objects;
drop policy if exists "public upload question images" on storage.objects;
drop policy if exists "public read quizzes" on public.quizzes;
drop policy if exists "public insert quizzes" on public.quizzes;
drop policy if exists "public update quizzes" on public.quizzes;
drop policy if exists "public delete quizzes" on public.quizzes;
drop policy if exists "public read questions" on public.questions;
drop policy if exists "public insert questions" on public.questions;
drop policy if exists "public update questions" on public.questions;
drop policy if exists "public delete questions" on public.questions;
drop policy if exists "public read sessions" on public.game_sessions;
drop policy if exists "public insert sessions" on public.game_sessions;
drop policy if exists "public update sessions" on public.game_sessions;
drop policy if exists "public read players" on public.game_players;
drop policy if exists "public insert players" on public.game_players;
drop policy if exists "public update players" on public.game_players;
drop policy if exists "public delete players" on public.game_players;
drop policy if exists "public read answers" on public.game_answers;
drop policy if exists "public insert answers" on public.game_answers;

create policy "public read quizzes" on public.quizzes for select using (true);
create policy "public insert quizzes" on public.quizzes for insert with check (true);
create policy "public update quizzes" on public.quizzes for update using (true);
create policy "public delete quizzes" on public.quizzes for delete using (true);

create policy "public read questions" on public.questions for select using (true);
create policy "public insert questions" on public.questions for insert with check (true);
create policy "public update questions" on public.questions for update using (true);
create policy "public delete questions" on public.questions for delete using (true);

create policy "public read sessions" on public.game_sessions for select using (true);
create policy "public insert sessions" on public.game_sessions for insert with check (true);
create policy "public update sessions" on public.game_sessions for update using (true);

create policy "public read players" on public.game_players for select using (true);
create policy "public insert players" on public.game_players for insert with check (true);
create policy "public update players" on public.game_players for update using (true);
create policy "public delete players" on public.game_players for delete using (true);

create policy "public read answers" on public.game_answers for select using (true);
create policy "public insert answers" on public.game_answers for insert with check (true);

create policy "public read question images"
on storage.objects for select
using (bucket_id = 'question-images');

create policy "public upload question images"
on storage.objects for insert
with check (bucket_id = 'question-images');

revoke all on function public.verify_admin_code(text) from public;
grant execute on function public.verify_admin_code(text) to anon, authenticated;

do $$
begin
  alter publication supabase_realtime add table public.game_sessions;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.game_players;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.game_answers;
exception
  when duplicate_object then null;
end $$;
