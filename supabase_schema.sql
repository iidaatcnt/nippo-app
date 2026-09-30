-- ==============================================================================
-- 日報アプリ (nippo-app) データベーススキーマ
-- Supabase の SQL Editor に貼り付けて「RUN」を実行してください
-- ==============================================================================

-- 1. Profiles テーブル（ユーザー属性管理）
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  full_name text,
  role text default 'employee' check (role in ('admin', 'employee')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- RLS（行レベルセキュリティ）を有効化
alter table public.profiles enable row level security;

create policy "Users can view own profile" 
  on public.profiles for select 
  using (auth.uid() = id);

create policy "Users can update own profile" 
  on public.profiles for update 
  using (auth.uid() = id);

-- 新規ユーザー登録時に自動で profiles にレコードを作成するトリガー
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)));
  return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 2. Daily Reports テーブル（日々の作業日報 ＆ 改善・効率化データ）
create table if not exists public.daily_reports (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  report_date date not null default current_date,
  work_summary text not null,          -- 本日の業務内容・実績
  improvement_points text not null,    -- 改善・効率化の気付き・提案（最重要）
  tomorrow_plan text,                  -- 明日の予定・改善アクション
  efficiency_score integer check (efficiency_score between 1 and 5), -- 効率・手応え（1〜5）
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 検索・集計用インデックス
create index if not exists idx_daily_reports_user_date on public.daily_reports (user_id, report_date desc);

-- RLS（行レベルセキュリティ）を有効化
alter table public.daily_reports enable row level security;

-- 自分が作成した日報のみ参照可能
create policy "Users can view own daily reports"
  on public.daily_reports for select
  using (auth.uid() = user_id);

-- 自分の日報のみ新規登録可能
create policy "Users can insert own daily reports"
  on public.daily_reports for insert
  with check (auth.uid() = user_id);

-- 自分の日報のみ更新可能
create policy "Users can update own daily reports"
  on public.daily_reports for update
  using (auth.uid() = user_id);
