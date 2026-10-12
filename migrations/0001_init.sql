-- 日報アプリ 初期スキーマ（Cloudflare D1 / SQLite）

-- クライアント企業（テナント）
CREATE TABLE tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  -- 企業ごとの設定（JSON）: { "showEndTime": true, "showKK": false, "standardEnd": "17:30" }
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ユーザー
-- role: employee=社員 / supervisor=上長 / owner=社長(企業管理者) / labor=労務管理者 / sysadmin=システム管理者(リライエ)
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('employee','supervisor','owner','labor','sysadmin')),
  supervisor_id INTEGER REFERENCES users(id),
  password_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  consented_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_supervisor ON users(supervisor_id);

-- 労務管理者の担当企業
CREATE TABLE labor_assignments (
  user_id INTEGER NOT NULL REFERENCES users(id),
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  PRIMARY KEY (user_id, tenant_id)
);

-- ログインセッション（トークンはSHA-256ハッシュで保存）
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 招待・パスワード再設定リンク
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- ログイン失敗の記録（総当たり対策）
CREATE TABLE login_failures (
  email TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_login_failures ON login_failures(email, at);

-- 日報
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  report_date TEXT NOT NULL,             -- YYYY-MM-DD (JST)
  condition INTEGER NOT NULL CHECK (condition BETWEEN 1 AND 5), -- 今日の調子
  done TEXT NOT NULL,                    -- 今日やったこと (D)
  redo TEXT NOT NULL DEFAULT '',         -- 今日もう一度やり直せるなら (A)
  growth TEXT NOT NULL DEFAULT '',       -- 気づき・成長の記録 (S)
  plan TEXT NOT NULL DEFAULT '',         -- 明日の予定 (P)
  end_time TEXT,                         -- 退勤時刻 HH:MM（任意）
  kk TEXT NOT NULL DEFAULT '',           -- 経営計画書の気になる一文（任意）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, report_date)
);
CREATE INDEX idx_reports_tenant_date ON reports(tenant_id, report_date);

-- 日報へのコメント・反応（PDFの「C 上司としてアドバイス」）
CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES reports(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','like')),
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_comments_report ON comments(report_id);

-- 既読
CREATE TABLE report_reads (
  report_id INTEGER NOT NULL REFERENCES reports(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (report_id, user_id)
);

-- 労務担当にだけ届く相談（上長・社長には見せない）
CREATE TABLE consultations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  report_id INTEGER REFERENCES reports(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_consultations_tenant ON consultations(tenant_id, created_at);

-- 兆候検知のキーワード辞書（tenant_id が NULL なら全社共通）
CREATE TABLE keyword_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES tenants(id),
  word TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low','mid','high'))
);

-- 兆候アラート（案件）
-- status: new=新規 / checking=確認中 / meeting=面談調整中 / in_progress=対応中 / closed=解決
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low','mid','high')),
  detail TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','checking','meeting','in_progress','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_alerts_tenant_status ON alerts(tenant_id, status);

-- アラートの対応記録
CREATE TABLE alert_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alerts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 社員ごとの現在ステータス（労務管理者が変更）
-- status: good=良好 / watch=様子見 / follow=要フォロー / handling=対応中 / leave=休職中
CREATE TABLE employee_status (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('good','watch','follow','handling','leave')),
  note TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ステータス変更履歴
CREATE TABLE status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  old_status TEXT,
  new_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  changed_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 監査ログ（誰がいつ何を見た・変えたか）
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 共通キーワード辞書の初期値
INSERT INTO keyword_rules (tenant_id, word, severity) VALUES
  (NULL, '死にたい', 'high'),
  (NULL, '消えたい', 'high'),
  (NULL, '自殺', 'high'),
  (NULL, '殴られ', 'high'),
  (NULL, 'セクハラ', 'high'),
  (NULL, 'パワハラ', 'high'),
  (NULL, 'ハラスメント', 'high'),
  (NULL, '怒鳴られ', 'mid'),
  (NULL, '無視され', 'mid'),
  (NULL, '人格否定', 'mid'),
  (NULL, '辞めたい', 'mid'),
  (NULL, '眠れない', 'mid'),
  (NULL, '限界', 'mid'),
  (NULL, 'つらい', 'low'),
  (NULL, 'しんどい', 'low'),
  (NULL, '疲れた', 'low'),
  (NULL, '休めない', 'low');
