# 日報アプリ (nippo-app)

社会保険労務士がクライアント企業に提供する、**コミュニケーションのための日報アプリ**です。
入力は1〜2分で終わるシンプルな形にし、蓄積したデータから長時間労働・メンタル不調・ハラスメントなどの兆候を早めに見つけ、労務管理者が状態を管理できるようにします。

設計の考え方は [docs/design.md](docs/design.md) を参照してください。

## できること

| 利用者 | できること |
|---|---|
| 社員 | 日報の入力（今日の調子＋やったこと＋任意項目）、履歴、上長コメントへの返信、**労務担当にだけ届く相談** |
| 上長 | 部下の日報の閲覧・既読・コメント・「見たよ」、未提出者の確認 |
| 社長 | 自社の日報閲覧、集計ダッシュボード（提出率・平均の調子・要フォロー人数）、ユーザー管理、日報項目の設定 |
| 労務管理者 | 担当企業のアラート対応（新規→確認中→面談調整中→対応中→解決）、社員ごとのステータス変更と履歴、相談の確認、キーワード辞書の編集 |
| システム管理者 | 企業の追加、労務管理者の担当企業の割り当て |

### 兆候の検知

- **提出時に即時**：気になる言葉（辞書は編集可）、労務担当への相談
- **毎晩 2:00（JST）に集計**：調子の低下、低調の連続、3営業日の未提出、長時間労働（退勤時刻から月末見込みを推計）、記述量の急減、上長の無反応

## 技術構成

- Cloudflare Workers（[Hono](https://hono.dev/)）＋ 静的アセット（`public/`、フレームワークなし）
- Cloudflare D1（`migrations/`）
- Cron Triggers（夜間集計）
- 認証：招待制のメール＋パスワード（PBKDF2）、HttpOnly Cookie セッション

## セットアップ

D1 データベース `nippo-db` は作成済みで、ID は `wrangler.jsonc` に設定してあります。

### Cloudflare から GitHub を連携してデプロイする（おすすめ）

1. Cloudflare ダッシュボードの「Workers & Pages」→「作成」→「リポジトリをインポート」で `iidaatcnt/nippo-app` を選ぶ
2. デプロイコマンドを `npm run deploy` にする（テーブル作成 → デプロイを続けて実行します）
3. 初回デプロイ後、Worker の「設定」→「変数とシークレット」に、シークレット `SETUP_TOKEN`（任意の長い文字列）を追加する

以後は main にマージするたびに自動でデプロイされます。

デプロイ後に URL を開くと初期セットアップ画面が出ます。SETUP_TOKEN と管理者のメールアドレス・パスワードを入力すると、システム管理者として使い始められます。
その後「管理」から企業を追加し、社長・上長・社員を招待します（招待リンクを Chatwork やメールで送ってください）。

### 手元のコマンドでデプロイする場合

```bash
npm install
npx wrangler login
npm run deploy
npx wrangler secret put SETUP_TOKEN
```

### ローカルで動かす

```bash
echo 'SETUP_TOKEN=local-setup-token' > .dev.vars
npm run db:migrate:local
npm run dev        # http://localhost:8787
npm test           # 兆候検知ルールのテスト
```

### GitHub Actions からの自動デプロイ（上の連携を使わない場合）

`.github/workflows/deploy.yml` が main へのマージで「マイグレーション → デプロイ」を実行します。
リポジトリの Settings で次を設定すると有効になります。

- Variables：`DEPLOY_ENABLED` = `true`
- Secrets：`CLOUDFLARE_API_TOKEN`（Workers と D1 の編集権限）、`CLOUDFLARE_ACCOUNT_ID`

## デモデータ

システム管理者でログインし、「管理」→「デモデータ」にデモユーザー用のパスワードを入れて「デモデータを入れる」を押すと、「デモ株式会社」（社長1・上長2・社員10・労務担当1）の約2ヶ月分のデータが入ります。
日付は押した日から逆算し、前営業日までの日報を作ります。コメント・既読、労務担当への相談、アラートとその対応記録、社員ステータスの履歴も含みます。アラートは夜間の兆候検知（`src/detect.ts`）を過去の日付で再現して作っているので、本番の検知と同じ形です。
同じ画面の「デモデータを消す」で、デモ会社のデータだけをまとめて消せます（生成のしくみは `src/demo.ts`）。

社員ごとに次のような筋書きがあります。

| 社員 | 筋書き |
|---|---|
| 鈴木 美咲 | 1ヶ月ほど前から調子が落ち、「怒鳴られ」「眠れない」「無視され」が出る。上長の反応が途絶え、労務担当に相談（対応中） |
| 高橋 翔 | 退勤が遅くなり続け、時間外が月45時間・80時間の見込みを超える |
| 山本 拓也 | 2週間ほど前から調子が落ち、ここ数日は日報が止まっている |
| 伊藤 大輔 | 直近1週間ほど、日報の記述が極端に短い |
| 中村 優子 | 期間の前半に一時的に不調、面談後に回復（解決済み） |
| 加藤 愛 | 月末だけ「疲れた」が出る |
| その他 | 普段どおり |

デモユーザーのメールアドレス（パスワードは入れるときに決めたもの）：

| 役割 | メールアドレス |
|---|---|
| 社長 | `demo-owner@example.com` |
| 上長（営業） | `demo-kimura@example.com` |
| 上長（業務） | `demo-hayashi@example.com` |
| 社員 | `demo-suzuki@example.com`、`demo-takahashi@example.com` など（`src/demo.ts` に一覧） |
| 労務担当 | `demo-labor@example.com` |

デモ会社の ID は `9000` です。

## 日報データの分析

日報はすべて D1（SQLite）に溜まっているので、SQL でそのまま集計できます。

### どこで SQL を実行するか

- **Cloudflare ダッシュボード**：「ストレージとデータベース」→「D1」→ `nippo-db` →「コンソール」に SQL を貼って実行
- **コマンド**：`npx wrangler d1 execute nippo-db --remote --command "SELECT ..." --json`
- **Excel などで見たいとき**：`npx wrangler d1 export nippo-db --remote --output nippo.sql` で丸ごと書き出し、`sqlite3 nippo.db < nippo.sql` で手元の SQLite に取り込み、`sqlite3 -header -csv nippo.db "SELECT ..." > 結果.csv` で CSV にする
- **Claude に頼む**：書き出した CSV を渡して「調子が落ちている人と理由を教えて」のように聞くこともできます

### 主なテーブル

| テーブル | 中身 |
|---|---|
| `reports` | 日報。`report_date`（日付）、`condition`（調子 1〜5）、`done`（やったこと）、`redo`（やり直せるなら）、`growth`（気づき）、`plan`（明日の予定）、`end_time`（退勤時刻） |
| `users` | 社員。`role`、`supervisor_id`（上長）、`tenant_id`（会社） |
| `comments` | 上長のコメント（`kind='comment'`）と「見たよ」（`kind='like'`） |
| `report_reads` | 既読 |
| `alerts` / `alert_notes` | 兆候アラートと対応記録 |
| `employee_status` / `status_history` | 社員の現在のステータスと変更履歴 |
| `consultations` | 労務担当への相談（**本人と労務担当以外には見せない情報です。扱いに注意してください**） |

### 集計の例

社員ごとの月別の提出日数と平均の調子：

```sql
SELECT u.name, substr(r.report_date, 1, 7) AS month,
       COUNT(*) AS days, ROUND(AVG(r.condition), 2) AS avg_condition
FROM reports r JOIN users u ON u.id = r.user_id
WHERE r.tenant_id = 9000
GROUP BY u.id, month ORDER BY u.name, month;
```

週ごとの調子の推移（会社全体）：

```sql
SELECT date(report_date, '-6 days', 'weekday 1') AS week,
       ROUND(AVG(condition), 2) AS avg_condition, COUNT(*) AS reports
FROM reports WHERE tenant_id = 9000
GROUP BY week ORDER BY week;
```

月別の時間外の推計（退勤時刻と所定終業 17:30 の差）：

```sql
SELECT u.name, substr(r.report_date, 1, 7) AS month,
       ROUND(SUM(MAX(0, (CAST(substr(r.end_time, 1, 2) AS INTEGER) * 60 + CAST(substr(r.end_time, 4, 2) AS INTEGER)) - (17 * 60 + 30))) / 60.0, 1) AS overtime_hours
FROM reports r JOIN users u ON u.id = r.user_id
WHERE r.tenant_id = 9000 AND r.end_time IS NOT NULL
GROUP BY u.id, month ORDER BY overtime_hours DESC;
```

上長ごとの反応率（部下の日報にコメントか「見たよ」をした割合）：

```sql
SELECT su.name AS supervisor, COUNT(DISTINCT r.id) AS reports,
       ROUND(100.0 * COUNT(DISTINCT c.report_id) / COUNT(DISTINCT r.id), 1) AS reaction_pct
FROM reports r
JOIN users u ON u.id = r.user_id
JOIN users su ON su.id = u.supervisor_id
LEFT JOIN comments c ON c.report_id = r.id AND c.user_id = su.id
WHERE r.tenant_id = 9000
GROUP BY su.id;
```

気になる言葉を含む日報：

```sql
SELECT r.report_date, u.name, k.word, k.severity
FROM reports r
JOIN users u ON u.id = r.user_id
JOIN keyword_rules k ON (k.tenant_id IS NULL OR k.tenant_id = r.tenant_id)
  AND instr(r.done || r.redo || r.growth || r.plan, k.word) > 0
WHERE r.tenant_id = 9000
ORDER BY r.report_date DESC;
```

アラートの種類と対応状況：

```sql
SELECT kind, status, COUNT(*) AS n
FROM alerts WHERE tenant_id = 9000
GROUP BY kind, status ORDER BY kind, status;
```

日報の文字数の推移（記述が短くなっている人を探す）：

```sql
SELECT u.name, date(r.report_date, '-6 days', 'weekday 1') AS week,
       ROUND(AVG(length(r.done || r.redo || r.growth)), 0) AS avg_chars
FROM reports r JOIN users u ON u.id = r.user_id
WHERE r.tenant_id = 9000
GROUP BY u.id, week ORDER BY u.name, week;
```

`tenant_id = 9000` はデモ会社です。実際の会社は `SELECT id, name FROM tenants;` で ID を確かめて置き換えてください。
日付・時刻のうち `report_date` は日本時間、`created_at` などの時刻は UTC（日本時間の9時間前）で保存しています。

## 今後の予定

- Chatwork／メールでのアラート通知
- AI による文章トーンの判定（要配慮個人情報の扱いを決めてから）
- 時間割（予定／実績）やタイピングテストなど企業ごとの任意項目、CSV 出力
