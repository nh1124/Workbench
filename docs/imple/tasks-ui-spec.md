# Tasks UI Specification（確定版）

Last updated: 2026-07-13（ユーザー確認済みの決定を反映）
関連: docs/imple/task-occurrence-stabilization-plan.md（identity 契約）, docs/imple/lbs-full-integration-plan.md

## 1. ビュー定義（表示単位と正本）

| ビュー | 単位 | データ源 | 内容 |
|---|---|---|---|
| Task List | タスク定義 | tasks.list | 全タスクのマスタ一覧（唯一のタスク定義ビュー） |
| Due Calendar | タスク定義 | tasks.list + recurrence 展開 | dueDate / occurrence 日にタスクを配置 |
| Schedule | occurrence | schedule-calendar（explicit＋generated） | 予定作業のカレンダー/タイムライン |
| Today | occurrence | 明示的 schedule item ＋ 当日 LBS occurrence（skipped 除外、taskId+occurrenceDate で重複排除） | 今日の作業。生成行は membership を持たず「Add to Today」で昇格可 |
| My Day | occurrence | Today 行 ∩ pinned | ピン留めの今日分 |
| Planned / Overdue | occurrence | schedule（±30日窓） | 窓内の未来/過去の未完了 occurrence |
| Inbox（改定） | occurrence | tasks.list + schedule 窓 | 下記 §2 |

- Today からの remove は明示的メンバーシップ削除であり、当日ルール発生する未完了 occurrence は同時に SKIP 例外を作成して再出現を防ぐ。

## 2. Inbox（決定: occurrence ベースへ変更）

- **Upcoming**: タスクごとに 1 行。
  - dueDate なしの ONCE タスク → 日付なし行（従来通り。Inbox は date-less タスクの受け皿を兼ねる）
  - dueDate ありの ONCE → その occurrence 行（完了操作は occurrence API）
  - 繰り返しタスク → **次の未完了 occurrence** を 1 行（無限展開はしない）
- **Completed**: 直近 30 日窓の**完了 occurrence 履歴**（schedule 窓の status=done から構築）。繰り返し・Overdue の occurrence 完了もここに現れる。
- 行 identity は occurrence（taskId + occurrenceDate）。dueDate なし行のみ taskId。

## 3. カウント定義（決定）

- **Planned / Overdue バッジ = タスク数**（窓内に該当 occurrence を 1 つ以上持つタスクの distinct 数）。無限繰り返しでも安定した数字になる。
- リスト内の見出し・グループには従来通り窓内 occurrence 数を表示してよい（期間をラベルで明示）。
- Today バッジ = Today 行数（現行踏襲）。Inbox バッジ = Upcoming 行数。

## 4. 同期・更新モデル（決定: SSE + 差分 refetch）

1. **楽観的更新**: occurrence 系 mutation は即時 UI 反映・失敗時ロールバック（実装済み）。
2. **SSE**: core に `GET /api/sync/events`（Server-Sent Events, JWT 認証）を追加。既存の `recordSyncEventBestEffort` の書き込みをストリーム配信する。UI は接続し、`tasks` ドメインのイベント受信で該当データを**デバウンス付き差分 refetch**（全 load ではなく tasks/today/schedule の必要部分）。切断時は指数バックオフで再接続、フォールバックは 60s ポーリング。
3. **操作後リロード**: mutation 成功後の reconcile は維持（SSE 到達とどちらか早い方。二重 refetch はデバウンスで吸収）。

## 5. ルーティング規律（split-brain 防止）

- ルーティングモード: `core` / `local` / `auto`。
- **auto モードの黙示フォールバックは読み取り（GET）のみ**。mutation（POST/PUT/PATCH/DELETE）は core 失敗時にローカル daemon へ黙って書き込んではならない（データ分裂の原因）。明示的エラーとして表面化する。
- auto での読み取りフォールバック発生時は、リクエスト単位で切り替えず**セッション sticky**（以後 local 固定）とし、ヘッダーにバナー表示。core 復帰はユーザー操作または再接続検出で。

## 6. エラー可視化

- API 失敗トーストには **HTTP status・対象バックエンド（core/local）・レスポンス message** を含める（例: `Failed to update occurrence (core, 403): LBS account token not provisioned`）。
- console.error に URL・メソッド・レスポンス本文を出す。「挙動不審」を一目で診断可能にする。

## 7. 既知の未解決事象（このスペックで診断可能にする）

- Today 完了トグルが即 rollback する事象: バックエンド（core→tasks→LBS）は API 直叩きで正常と実証済み。browser→core の complete POST が失敗している。§6 の可視化導入後に status/message で確定させる。

## 8. カレンダー UX（2026-07-13 ユーザー要望）

1. **連続月スクロール**: 月表示はページ切替ではなく縦の連続スクロール。スクロールで前後の月を遅延レンダリングし、ヘッダの年月ラベルは可視領域の主要月に追随。「TODAY」は当月へスクロール。Due Calendar / Schedule 両方の月モードに適用。
2. **週タイムラインの高さ**: タイムラインはビューポート残り高さいっぱいに伸ばす（時間スロット高を可変にし、最小値以上で引き伸ばす）。縦長ウィンドウで下部が空くレイアウトを禁止。
3. **別ウィンドウ**: カレンダー（Due/Schedule）をカレンダー専用のスタンドアロン表示（サイドバー非表示）で別ウィンドウに開ける。導線は (a) サイドバーのカレンダー項目の右クリック「別ウィンドウで開く」、(b) キーボードショートカット。Tauri 環境では WebviewWindow、ブラウザでは window.open。
4. **カレンダーからの追加**: (a) 月セル右クリック→「この日にタスクを追加」（quick-add を dueDate プリフィルで開く）。(b) 週タイムラインで縦ドラッグ範囲選択→その日付＋開始/終了時刻をプリフィルした追加ポップオーバー（新規タスク作成、または既存タスクの schedule item 作成を選択）。
