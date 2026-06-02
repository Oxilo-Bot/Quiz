create extension if not exists pgcrypto;

create table if not exists public.admin_codes (
  id uuid primary key default gen_random_uuid(),
  label text not null default 'Admin',
  code_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
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
  player_token_hash text,
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
alter table public.game_players add column if not exists player_token_hash text;
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
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.admin_codes
    where is_active = true
      and code_hash = extensions.crypt(admin_code_input, code_hash)
  );
$$;

create or replace function public.create_admin_session(admin_code_input text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  session_token text;
begin
  if not public.verify_admin_code(admin_code_input) then
    perform pg_sleep(1);
    raise exception 'Code admin incorrect.';
  end if;

  delete from public.admin_sessions
  where expires_at < now() or revoked_at is not null;

  session_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.admin_sessions (token_hash, expires_at)
  values (extensions.crypt(session_token, extensions.gen_salt('bf')), now() + interval '8 hours');

  return session_token;
end;
$$;

create or replace function public.is_valid_admin_session(admin_token_input text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.admin_sessions
    where admin_token_input is not null
      and revoked_at is null
      and expires_at > now()
      and token_hash = extensions.crypt(admin_token_input, token_hash)
  );
$$;

create or replace function public.require_admin_session(admin_token_input text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_valid_admin_session(admin_token_input) then
    raise exception 'Session admin invalide. Reconnecte-toi avec le code admin.';
  end if;
end;
$$;

create or replace function public.is_valid_player_session(player_id_input uuid, player_token_input text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.game_players
    where id = player_id_input
      and player_token_input is not null
      and player_token_hash is not null
      and player_token_hash = extensions.crypt(player_token_input, player_token_hash)
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

create or replace function public.admin_list_quizzes(admin_token_input text)
returns table(id uuid, title text, description text, created_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.require_admin_session(admin_token_input);

  return query
  select q.id, q.title, q.description, q.created_at
  from public.quizzes q
  order by q.created_at desc;
end;
$$;

create or replace function public.admin_create_quiz(
  admin_token_input text,
  title_input text,
  description_input text,
  host_token_input text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_id uuid;
begin
  perform public.require_admin_session(admin_token_input);

  insert into public.quizzes (title, description, host_token)
  values (nullif(trim(title_input), ''), coalesce(trim(description_input), ''), coalesce(host_token_input, 'admin'))
  returning id into new_id;

  return new_id;
end;
$$;

create or replace function public.admin_update_quiz(
  admin_token_input text,
  quiz_id_input uuid,
  title_input text,
  description_input text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.require_admin_session(admin_token_input);

  update public.quizzes
  set title = nullif(trim(title_input), ''),
      description = coalesce(trim(description_input), '')
  where id = quiz_id_input;

  if not found then
    raise exception 'Quiz introuvable.';
  end if;
end;
$$;

create or replace function public.admin_delete_quiz(admin_token_input text, quiz_id_input uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.require_admin_session(admin_token_input);

  delete from public.quizzes
  where id = quiz_id_input;

  return found;
end;
$$;

create or replace function public.admin_get_quiz_title(admin_token_input text, quiz_id_input uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  quiz_title text;
begin
  perform public.require_admin_session(admin_token_input);

  select q.title into quiz_title
  from public.quizzes q
  where q.id = quiz_id_input;

  return quiz_title;
end;
$$;

create or replace function public.admin_list_questions(admin_token_input text, quiz_id_input uuid)
returns table(
  id uuid,
  quiz_id uuid,
  question_type text,
  body text,
  answers jsonb,
  image_url text,
  correct_index int,
  duration_seconds int,
  min_points int,
  max_points int,
  position int,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.require_admin_session(admin_token_input);

  return query
  select q.id, q.quiz_id, q.question_type, q.body, q.answers, q.image_url, q.correct_index,
         q.duration_seconds, q.min_points, q.max_points, q.position, q.created_at
  from public.questions q
  where q.quiz_id = quiz_id_input
  order by q.position asc, q.created_at asc;
end;
$$;

create or replace function public.admin_upsert_question(
  admin_token_input text,
  question_id_input uuid,
  quiz_id_input uuid,
  question_type_input text,
  body_input text,
  answers_input jsonb,
  image_url_input text,
  correct_index_input int,
  duration_seconds_input int,
  min_points_input int,
  max_points_input int
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  saved_id uuid;
  question_count int;
  answer_count int;
  safe_answers jsonb := coalesce(answers_input, '[]'::jsonb);
begin
  perform public.require_admin_session(admin_token_input);

  if question_type_input not in ('multiple_choice', 'free_text', 'image_reveal') then
    raise exception 'Type de question invalide.';
  end if;

  if nullif(trim(body_input), '') is null then
    raise exception 'La question est obligatoire.';
  end if;

  if max_points_input < min_points_input then
    raise exception 'Les points maximum doivent etre superieurs aux points minimum.';
  end if;

  answer_count := jsonb_array_length(safe_answers);
  if question_type_input <> 'free_text' then
    if answer_count < 2 or answer_count > 6 then
      raise exception 'Une question a choix doit avoir entre 2 et 6 reponses.';
    end if;

    if correct_index_input < 0 or correct_index_input >= answer_count then
      raise exception 'Bonne reponse invalide.';
    end if;
  else
    safe_answers := '[]'::jsonb;
    correct_index_input := 0;
  end if;

  if question_id_input is null then
    select count(*) into question_count
    from public.questions
    where quiz_id = quiz_id_input;

    if question_count >= 20 then
      raise exception 'Un quiz ne peut pas depasser 20 questions.';
    end if;

    insert into public.questions (
      quiz_id, question_type, body, answers, image_url, correct_index,
      duration_seconds, min_points, max_points, position
    )
    values (
      quiz_id_input, question_type_input, trim(body_input), safe_answers, image_url_input,
      correct_index_input, duration_seconds_input, min_points_input, max_points_input, question_count
    )
    returning id into saved_id;
  else
    update public.questions
    set question_type = question_type_input,
        body = trim(body_input),
        answers = safe_answers,
        image_url = image_url_input,
        correct_index = correct_index_input,
        duration_seconds = duration_seconds_input,
        min_points = min_points_input,
        max_points = max_points_input
    where id = question_id_input
      and quiz_id = quiz_id_input
    returning id into saved_id;

    if saved_id is null then
      raise exception 'Question introuvable.';
    end if;
  end if;

  return saved_id;
end;
$$;

create or replace function public.admin_delete_question(admin_token_input text, question_id_input uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  parent_quiz_id uuid;
begin
  perform public.require_admin_session(admin_token_input);

  select q.quiz_id into parent_quiz_id
  from public.questions q
  where q.id = question_id_input;

  delete from public.questions
  where id = question_id_input;

  if parent_quiz_id is not null then
    with ordered as (
      select q.id, row_number() over (order by q.position asc, q.created_at asc) - 1 as new_position
      from public.questions q
      where q.quiz_id = parent_quiz_id
    )
    update public.questions q
    set position = ordered.new_position
    from ordered
    where q.id = ordered.id;
  end if;

  return parent_quiz_id is not null;
end;
$$;

create or replace function public.admin_start_session(
  admin_token_input text,
  quiz_id_input uuid,
  host_token_input text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  question_count int;
  code_candidate text;
  new_session public.game_sessions%rowtype;
begin
  perform public.require_admin_session(admin_token_input);

  select count(*) into question_count
  from public.questions
  where quiz_id = quiz_id_input;

  if question_count = 0 then
    raise exception 'Ajoute au moins une question.';
  end if;

  for i in 1..20 loop
    code_candidate := lpad(floor(random() * 1000000)::int::text, 6, '0');
    begin
      insert into public.game_sessions (
        quiz_id, code, host_token, status, access_enabled,
        show_answer, show_leaderboard, points_awarded, current_question_index
      )
      values (
        quiz_id_input, code_candidate, coalesce(host_token_input, 'admin'), 'lobby', true,
        false, false, false, -1
      )
      returning * into new_session;

      return jsonb_build_object('id', new_session.id, 'code', new_session.code);
    exception
      when unique_violation then
        null;
    end;
  end loop;

  raise exception 'Impossible de generer un code de partie.';
end;
$$;

create or replace function public.admin_get_session_state(admin_token_input text, session_id_input uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  result jsonb;
begin
  perform public.require_admin_session(admin_token_input);

  select jsonb_build_object(
    'id', s.id,
    'quiz_id', s.quiz_id,
    'code', s.code,
    'status', s.status,
    'access_enabled', s.access_enabled,
    'show_answer', s.show_answer,
    'show_leaderboard', s.show_leaderboard,
    'points_awarded', s.points_awarded,
    'current_question_index', s.current_question_index,
    'question_started_at', s.question_started_at,
    'quiz_title', qz.title,
    'questions', coalesce((
      select jsonb_agg(to_jsonb(q) order by q.position asc, q.created_at asc)
      from public.questions q
      where q.quiz_id = s.quiz_id
    ), '[]'::jsonb)
  )
  into result
  from public.game_sessions s
  join public.quizzes qz on qz.id = s.quiz_id
  where s.id = session_id_input;

  return result;
end;
$$;

create or replace function public.admin_list_players(
  admin_token_input text,
  session_id_input uuid,
  order_by_score_input boolean default false
)
returns table(id uuid, nickname text, score int, joined_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.require_admin_session(admin_token_input);

  if order_by_score_input then
    return query
    select p.id, p.nickname, p.score, p.joined_at
    from public.game_players p
    where p.session_id = session_id_input
    order by p.score desc, p.joined_at asc;
  else
    return query
    select p.id, p.nickname, p.score, p.joined_at
    from public.game_players p
    where p.session_id = session_id_input
    order by p.joined_at asc;
  end if;
end;
$$;

create or replace function public.admin_start_live_game(admin_token_input text, session_id_input uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  session_row public.game_sessions%rowtype;
  question_count int;
begin
  perform public.require_admin_session(admin_token_input);

  select * into session_row
  from public.game_sessions
  where id = session_id_input
  for update;

  if not found then
    raise exception 'Session introuvable.';
  end if;

  if session_row.status = 'finished' then
    raise exception 'Cette partie est fermee.';
  end if;

  if session_row.current_question_index >= 0 then
    raise exception 'La partie a deja demarre.';
  end if;

  select count(*) into question_count
  from public.questions
  where quiz_id = session_row.quiz_id;

  if question_count = 0 then
    raise exception 'Ajoute au moins une question.';
  end if;

  update public.game_sessions
  set current_question_index = 0,
      status = 'playing',
      access_enabled = false,
      show_answer = false,
      show_leaderboard = false,
      points_awarded = false,
      question_started_at = now()
  where id = session_id_input;
end;
$$;

create or replace function public.admin_continue_live_game(admin_token_input text, session_id_input uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  session_row public.game_sessions%rowtype;
  question_row public.questions%rowtype;
  question_count int;
  next_index int;
begin
  perform public.require_admin_session(admin_token_input);

  select * into session_row
  from public.game_sessions
  where id = session_id_input
  for update;

  if not found or session_row.status <> 'playing' then
    return;
  end if;

  select count(*) into question_count
  from public.questions
  where quiz_id = session_row.quiz_id;

  if not session_row.show_answer then
    select * into question_row
    from public.questions
    where quiz_id = session_row.quiz_id
    order by position asc, created_at asc
    offset greatest(session_row.current_question_index, 0)
    limit 1;

    if not session_row.points_awarded and question_row.id is not null and question_row.question_type <> 'free_text' then
      update public.game_players p
      set score = p.score + a.points
      from public.game_answers a
      where a.player_id = p.id
        and a.session_id = session_id_input
        and a.question_id = question_row.id
        and a.is_correct = true;
    end if;

    update public.game_sessions
    set show_answer = true,
        points_awarded = true
    where id = session_id_input;

    return;
  end if;

  if not session_row.show_leaderboard then
    update public.game_sessions
    set show_leaderboard = true
    where id = session_id_input;

    return;
  end if;

  next_index := session_row.current_question_index + 1;

  if next_index >= question_count then
    update public.game_sessions
    set status = 'finished',
        access_enabled = false,
        show_answer = false,
        show_leaderboard = false,
        points_awarded = false
    where id = session_id_input;

    return;
  end if;

  update public.game_sessions
  set current_question_index = next_index,
      show_answer = false,
      show_leaderboard = false,
      points_awarded = false,
      question_started_at = now()
  where id = session_id_input;
end;
$$;

create or replace function public.admin_end_session(admin_token_input text, session_id_input uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.require_admin_session(admin_token_input);

  update public.game_sessions
  set status = 'finished',
      access_enabled = false,
      show_answer = false,
      show_leaderboard = false,
      points_awarded = false
  where id = session_id_input;
end;
$$;

create or replace function public.admin_set_session_access(
  admin_token_input text,
  session_id_input uuid,
  enabled_input boolean
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.require_admin_session(admin_token_input);

  update public.game_sessions
  set access_enabled = enabled_input
  where id = session_id_input
    and status <> 'finished';
end;
$$;

create or replace function public.admin_kick_player(admin_token_input text, player_id_input uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.require_admin_session(admin_token_input);

  delete from public.game_players
  where id = player_id_input;
end;
$$;

create or replace function public.join_game_by_code(code_input text, nickname_input text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  session_row public.game_sessions%rowtype;
  new_player public.game_players%rowtype;
  player_token text;
begin
  select * into session_row
  from public.game_sessions
  where code = upper(trim(code_input))
    and status <> 'finished'
  limit 1;

  if not found then
    raise exception 'Partie introuvable.';
  end if;

  if not session_row.access_enabled then
    raise exception 'L''acces a cette partie est temporairement bloque.';
  end if;

  if nullif(trim(nickname_input), '') is null then
    raise exception 'Pseudo obligatoire.';
  end if;

  player_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.game_players (session_id, nickname, player_token_hash, score)
  values (
    session_row.id,
    left(trim(nickname_input), 32),
    extensions.crypt(player_token, extensions.gen_salt('bf')),
    0
  )
  returning * into new_player;

  return jsonb_build_object(
    'id', new_player.id,
    'session_id', new_player.session_id,
    'nickname', new_player.nickname,
    'player_token', player_token
  );
end;
$$;

create or replace function public.get_player_state(player_id_input uuid, player_token_input text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  player_row public.game_players%rowtype;
  session_row public.game_sessions%rowtype;
  question_row public.questions%rowtype;
  answer_row public.game_answers%rowtype;
  quiz_title text;
  visible_question jsonb := null;
  visible_answer jsonb := null;
begin
  if not public.is_valid_player_session(player_id_input, player_token_input) then
    return null;
  end if;

  select * into player_row
  from public.game_players
  where id = player_id_input;

  if not found then
    return null;
  end if;

  select * into session_row
  from public.game_sessions
  where id = player_row.session_id;

  if not found then
    return null;
  end if;

  select qz.title into quiz_title
  from public.quizzes qz
  where qz.id = session_row.quiz_id;

  if session_row.status = 'playing' and session_row.current_question_index >= 0 then
    select * into question_row
    from public.questions
    where quiz_id = session_row.quiz_id
    order by position asc, created_at asc
    offset greatest(session_row.current_question_index, 0)
    limit 1;

    if question_row.id is not null then
      visible_question := jsonb_build_object(
        'id', question_row.id,
        'question_type', question_row.question_type,
        'body', question_row.body,
        'answers', question_row.answers,
        'image_url', question_row.image_url,
        'duration_seconds', question_row.duration_seconds
      );

      if session_row.show_answer and question_row.question_type <> 'free_text' then
        visible_question := visible_question || jsonb_build_object('correct_index', question_row.correct_index);
      end if;

      select * into answer_row
      from public.game_answers
      where player_id = player_row.id
        and question_id = question_row.id
      limit 1;

      if answer_row.id is not null then
        visible_answer := jsonb_build_object(
          'id', answer_row.id,
          'answer_index', answer_row.answer_index,
          'answer_text', answer_row.answer_text,
          'is_correct', case when session_row.show_answer then answer_row.is_correct else null end,
          'points', case when session_row.show_answer then answer_row.points else null end
        );
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'player', jsonb_build_object(
      'id', player_row.id,
      'session_id', player_row.session_id,
      'nickname', player_row.nickname,
      'score', player_row.score
    ),
    'session', jsonb_build_object(
      'id', session_row.id,
      'status', session_row.status,
      'show_answer', session_row.show_answer,
      'show_leaderboard', session_row.show_leaderboard,
      'current_question_index', session_row.current_question_index,
      'question_started_at', session_row.question_started_at,
      'quiz_title', quiz_title
    ),
    'question', visible_question,
    'answer', visible_answer
  );
end;
$$;

create or replace function public.submit_choice_answer(
  player_id_input uuid,
  player_token_input text,
  question_id_input uuid,
  answer_index_input int
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  player_row public.game_players%rowtype;
  session_row public.game_sessions%rowtype;
  question_row public.questions%rowtype;
  expected_question_id uuid;
  answer_count int;
  correct boolean;
  earned_points int := 0;
  elapsed_seconds numeric;
  duration_value numeric;
  remaining_ratio numeric;
begin
  if not public.is_valid_player_session(player_id_input, player_token_input) then
    raise exception 'Session joueur invalide.';
  end if;

  select * into player_row
  from public.game_players
  where id = player_id_input;

  select * into session_row
  from public.game_sessions
  where id = player_row.session_id
  for update;

  if session_row.status <> 'playing' or session_row.show_answer or session_row.show_leaderboard then
    raise exception 'La reponse est fermee pour cette question.';
  end if;

  select q.id into expected_question_id
  from public.questions q
  where q.quiz_id = session_row.quiz_id
  order by q.position asc, q.created_at asc
  offset greatest(session_row.current_question_index, 0)
  limit 1;

  if expected_question_id <> question_id_input then
    raise exception 'Cette question n''est plus active.';
  end if;

  select * into question_row
  from public.questions
  where id = question_id_input;

  if question_row.question_type = 'free_text' then
    raise exception 'Cette question attend une reponse libre.';
  end if;

  answer_count := jsonb_array_length(question_row.answers);
  if answer_index_input < 0 or answer_index_input >= answer_count then
    raise exception 'Reponse invalide.';
  end if;

  correct := answer_index_input = question_row.correct_index;

  if correct then
    elapsed_seconds := greatest(0, extract(epoch from (clock_timestamp() - coalesce(session_row.question_started_at, now()))));
    duration_value := greatest(1, question_row.duration_seconds);
    remaining_ratio := greatest(0, least(1, 1 - elapsed_seconds / duration_value));
    earned_points := round(question_row.min_points + (question_row.max_points - question_row.min_points) * remaining_ratio)::int;
  end if;

  insert into public.game_answers (
    session_id, player_id, question_id, answer_index, answer_text, is_correct, points
  )
  values (
    session_row.id, player_row.id, question_row.id, answer_index_input, null, correct, earned_points
  );
end;
$$;

create or replace function public.submit_free_answer(
  player_id_input uuid,
  player_token_input text,
  question_id_input uuid,
  answer_text_input text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  player_row public.game_players%rowtype;
  session_row public.game_sessions%rowtype;
  question_row public.questions%rowtype;
  expected_question_id uuid;
begin
  if not public.is_valid_player_session(player_id_input, player_token_input) then
    raise exception 'Session joueur invalide.';
  end if;

  if nullif(trim(answer_text_input), '') is null then
    raise exception 'Reponse obligatoire.';
  end if;

  select * into player_row
  from public.game_players
  where id = player_id_input;

  select * into session_row
  from public.game_sessions
  where id = player_row.session_id
  for update;

  if session_row.status <> 'playing' or session_row.show_answer or session_row.show_leaderboard then
    raise exception 'La reponse est fermee pour cette question.';
  end if;

  select q.id into expected_question_id
  from public.questions q
  where q.quiz_id = session_row.quiz_id
  order by q.position asc, q.created_at asc
  offset greatest(session_row.current_question_index, 0)
  limit 1;

  if expected_question_id <> question_id_input then
    raise exception 'Cette question n''est plus active.';
  end if;

  select * into question_row
  from public.questions
  where id = question_id_input;

  if question_row.question_type <> 'free_text' then
    raise exception 'Cette question attend un choix.';
  end if;

  insert into public.game_answers (
    session_id, player_id, question_id, answer_index, answer_text, is_correct, points
  )
  values (
    session_row.id, player_row.id, question_row.id, null, left(trim(answer_text_input), 120), false, 0
  );
end;
$$;

create or replace function public.get_session_leaderboard(session_id_input uuid)
returns table(nickname text, score int)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not exists (
    select 1
    from public.game_sessions s
    where s.id = session_id_input
      and (s.show_leaderboard = true or s.status = 'finished')
  ) then
    return;
  end if;

  return query
  select p.nickname, p.score
  from public.game_players p
  where p.session_id = session_id_input
  order by p.score desc, p.joined_at asc
  limit 10;
end;
$$;

create or replace function public.get_free_text_counts(session_id_input uuid, question_id_input uuid)
returns table(answer_text text, answer_count bigint)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not exists (
    select 1
    from public.game_sessions s
    where s.id = session_id_input
      and (s.show_leaderboard = true or s.status = 'finished')
  ) then
    return;
  end if;

  return query
  select lower(trim(regexp_replace(coalesce(a.answer_text, ''), '\s+', ' ', 'g'))) as answer_text,
         count(*) as answer_count
  from public.game_answers a
  where a.session_id = session_id_input
    and a.question_id = question_id_input
    and nullif(trim(a.answer_text), '') is not null
  group by lower(trim(regexp_replace(coalesce(a.answer_text, ''), '\s+', ' ', 'g')))
  order by count(*) desc, 1 asc
  limit 10;
end;
$$;

alter table public.admin_codes enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.quizzes enable row level security;
alter table public.questions enable row level security;
alter table public.game_sessions enable row level security;
alter table public.game_players enable row level security;
alter table public.game_answers enable row level security;

drop policy if exists "public read admin codes" on public.admin_codes;
drop policy if exists "public read admin sessions" on public.admin_sessions;
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

create policy "public read question images"
on storage.objects for select
using (bucket_id = 'question-images');

create policy "public upload question images"
on storage.objects for insert
with check (bucket_id = 'question-images');

revoke all on function public.is_valid_admin_session(text) from public;
revoke all on function public.require_admin_session(text) from public;
revoke all on function public.is_valid_player_session(uuid, text) from public;
revoke all on function public.verify_admin_code(text) from public;

grant execute on function public.create_admin_session(text) to anon, authenticated;
grant execute on function public.admin_list_quizzes(text) to anon, authenticated;
grant execute on function public.admin_create_quiz(text, text, text, text) to anon, authenticated;
grant execute on function public.admin_update_quiz(text, uuid, text, text) to anon, authenticated;
grant execute on function public.admin_delete_quiz(text, uuid) to anon, authenticated;
grant execute on function public.admin_get_quiz_title(text, uuid) to anon, authenticated;
grant execute on function public.admin_list_questions(text, uuid) to anon, authenticated;
grant execute on function public.admin_upsert_question(text, uuid, uuid, text, text, jsonb, text, int, int, int, int) to anon, authenticated;
grant execute on function public.admin_delete_question(text, uuid) to anon, authenticated;
grant execute on function public.admin_start_session(text, uuid, text) to anon, authenticated;
grant execute on function public.admin_get_session_state(text, uuid) to anon, authenticated;
grant execute on function public.admin_list_players(text, uuid, boolean) to anon, authenticated;
grant execute on function public.admin_start_live_game(text, uuid) to anon, authenticated;
grant execute on function public.admin_continue_live_game(text, uuid) to anon, authenticated;
grant execute on function public.admin_end_session(text, uuid) to anon, authenticated;
grant execute on function public.admin_set_session_access(text, uuid, boolean) to anon, authenticated;
grant execute on function public.admin_kick_player(text, uuid) to anon, authenticated;
grant execute on function public.join_game_by_code(text, text) to anon, authenticated;
grant execute on function public.get_player_state(uuid, text) to anon, authenticated;
grant execute on function public.submit_choice_answer(uuid, text, uuid, int) to anon, authenticated;
grant execute on function public.submit_free_answer(uuid, text, uuid, text) to anon, authenticated;
grant execute on function public.get_session_leaderboard(uuid) to anon, authenticated;
grant execute on function public.get_free_text_counts(uuid, uuid) to anon, authenticated;

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
