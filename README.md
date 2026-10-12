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

```bash
npm install

# 1. D1 データベースを作成し、出力された database_id を wrangler.jsonc に書き込む
npx wrangler d1 create nippo-db

# 2. テーブルを作成
npm run db:migrate:remote

# 3. 初期セットアップ用のトークンを登録（最初の管理者を作るときだけ使います）
npx wrangler secret put SETUP_TOKEN

# 4. デプロイ
npm run deploy
```

デプロイ後に URL を開くと初期セットアップ画面が出ます。SETUP_TOKEN と管理者のメールアドレス・パスワードを入力すると、システム管理者として使い始められます。
その後「管理」から企業を追加し、社長・上長・社員を招待します（招待リンクを Chatwork やメールで送ってください）。

### ローカルで動かす

```bash
echo 'SETUP_TOKEN=local-setup-token' > .dev.vars
npm run db:migrate:local
npm run dev        # http://localhost:8787
npm test           # 兆候検知ルールのテスト
```

### GitHub からの自動デプロイ

`.github/workflows/deploy.yml` が main へのマージで「マイグレーション → デプロイ」を実行します。
リポジトリの Settings で次を設定すると有効になります。

- Variables：`DEPLOY_ENABLED` = `true`
- Secrets：`CLOUDFLARE_API_TOKEN`（Workers と D1 の編集権限）、`CLOUDFLARE_ACCOUNT_ID`

## 今後の予定

- Chatwork／メールでのアラート通知
- AI による文章トーンの判定（要配慮個人情報の扱いを決めてから）
- 時間割（予定／実績）やタイピングテストなど企業ごとの任意項目、CSV 出力
