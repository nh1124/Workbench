# Tasks UI 修正計画（2026-07）

Today カウント不一致・初期表示ラグ・全タスク検索・Done 反映ラグ・付随バグの 5 課題を対象とする。
実装体制は Codex worker delegation（Claude=調査/計画/レビュー/commit、Codex=wave 実装）。

## 対象範囲と根本原因

### 課題1: Today カウント不一致（バグ）
- 症状: サイドバー `Today` バッジ = 0 なのにリストには 9 件表示。
- 原因: バッジは [`computeTaskCounters`](../../ui/src/tasks/lib/taskFilterUtils.ts) が `todayMembershipKeys.size`（＝明示的 Today 登録のみ）を返す。
  一方リストは [`buildTodayRows`](../../ui/src/tasks/lib/taskTodayRows.ts) が「明示 Today ＋ LBS スケジュール発生分（日課系）」を返す。日課はメンバーシップキーを追加しないため乖離。
- 方針（確定）: バッジ = **未完了の Today 表示行数**（`todayRows` のうち `status !== "done"`）。`myday` も同様に pinned な未完了 today 行数へ揃える（現在 `tasks.filter(isPinned)` で done 含む master 基準なのでリストとズレる）。

### 課題2: 初期表示リードタイム
- 原因: [`useTaskDataLoader.load`](../../ui/src/tasks/hooks/useTaskDataLoader.ts) が初回に 7 本の API を `Promise.all` し、全部揃うまで `isLoading=true`（空表示）。
  Today 表示に必須なのは `tasks.list` / `tasks.projects` / `todayList` / `schedule(today)` のみ。`schedule(±30d)` / `scheduleCalendar(±30d)`（planned/overdue カウンタ・カレンダー状態用）は Today 描画に不要。
- 方針: `load` を **2 段階**化。
  - Phase A（必須・待つ）: tasks / projects / todayList / schedule(today) → 揃った時点で `tasks/todayRows/projectOptions` を set し `isLoading=false`。
  - Phase B（付随・非同期）: schedule(±30d) / scheduleCalendar(±30d) → 解決後に planned/overdue/inbox/calendarStatusMap を set。
  - `requestId` によるレース保護は現行踏襲。`silent`/`shouldApply` の意味論は維持。Phase B 単独失敗は Phase A の成功を損なわない。

### 課題3: 全タスク検索（新機能）
- UI（確定）: ヘッダーの download/upload の隣に 🔍 アイコン。クリックでモーダル検索。
- 対象: **全タスク**（`contextFilter` に依存しない）。`tasks` は `list(contextFilter)` で絞られるため、モーダルを開いたら `tasksApi.list()`（無フィルタ）を都度取得してソースにする。
- 検索項目: フリーワード（title / context / notes）＋ 任意で project / status 絞り込み。
- 結果クリック → 既存 `selectTask` で詳細パネルを開く（`navigate` state の openTaskId 経路は不要、同ページ内）。
- 実装: 新規 `TaskSearchModal.tsx` ＋ 純関数 `searchTasks(tasks, {query, projectId, status})` を `taskFilterUtils.ts` に追加（単体テスト可能に）。ヘッダーに `onOpenSearch` prop を追加。

### 課題4: Done → Completed 反映ラグ
- 静的解析: 楽観更新（[`runOptimisticOccurrenceMutation`](../../ui/src/tasks/lib/taskOccurrenceStatusMutation.ts)）は即時に `todayRows` の status を done にするため、TaskListContent の active/done 分割で即座に Completed へ畳まれる**はず**。
- 疑い: 完了後 `finishOccurrenceMutation` → `scheduleBackgroundRefresh`（800ms 後 silent `load`）で `todayRows` をサーバ再構築する際、生成発生（LBS）の完了がサーバ側の次 `schedule` 応答へ即反映されないと、行が todo に戻り一瞬 active へ復帰 → 再度畳まれる「ちらつき」。
- 方針:
  1. **live で再現確認**（codex 併用、dev サーバ）。ちらつき有無・タイミングを特定。
  2. ちらつきが確認されたら、silent 再構築時に「直近ローカル完了済み occurrence」を保持する（`load` の適用直前に in-flight/直近確定 mutation の status を優先マージ）か、`completeOccurrence` 応答が反映されるまで当該行の楽観 status を上書きしない。
  3. 併せて、Completed セクションが `todayCompletedOpen=false` で畳まれる導線は維持（即畳みは仕様として正しい）。

### 課題5: 付随バグ調査
- 最終レビューで Codex read-only により全 diff＋周辺（`useTaskDataLoader` の Phase 分割で counter が undefined 期間に出ないか、`counters.today` 変更でカレンダー/スケジュールモードへの副作用が無いか、検索モーダルのフォーカストラップ/Escape/多重フェッチ）を点検。
- 既知の要確認点: `filterTasksByMode("today")` は今も membershipKeys 依存だが Today リスト描画には未使用（occurrence 経路）。counter 変更後も本関数の挙動を変えない（calendar/schedule 経路が使用）。

## Codex read-only レビュー結果（2026-07-24 反映）
- 課題1: CONFIRMED。My Day バッジも要修正（`todayRows.filter(pinned && status!=="done")`）。counter 変更はカレンダー/スケジュール経路に副作用なし（`filterTasksByMode` は別経路、Today リストは occurrence 経路）。
- 課題2: PARTIALLY-CORRECT。Phase B は counter 以外に **Inbox 行**（`setInboxUpcomingRows/DoneRows`）も含む。単純分割だと `isLoading=false` 後・Phase B 前に Inbox が「No Tasks」誤表示。→ **Phase B 用 readiness/loading state を別に持つ**。`load(): Promise<boolean>` の戻り意味論（背景再構築が false を「要再試行」と解釈）を維持。requestId/shouldApply は両 commit で独立適用。
- 課題4: PARTIALLY-CORRECT。stale un-fold の窓＝「todo を掴んだ背景ロードが `finishOccurrenceMutation` のバージョン削除後に完了 → `shouldApply` が in-flight 無しと判定し古い todo を commit」。→ **load 開始時に mutation-settled カウンタを捕捉し、適用直前に増えていたら破棄**（または直近確定完了 status のオーバーレイ保持）。Refresh ボタン（shouldApply 無し）は明示操作として許容。
- 課題5 追加バグ（本計画に取り込む）:
  - (a) `todayList` が `contextFilter` を無視 → プロジェクト絞込時に他プロジェクト Today が混入。Today カウント/表示の正確性に直結 → **Wave 1/2 圏で修正**。
  - (b) wide-range 失敗が空配列で counter/inbox/calendarStatusMap を上書き → **Wave 2 で「失敗時は前回値保持」**。
  - (c) explicit skipped の Today 行が active 表示（generated skipped のみ除外）→ **Wave 4 圏で `status!=="skipped"` も active から除外**。
  - (d) `sortOccurrenceRows` の startTime 無し行がコメントと逆（先頭に来る）→ 軽微、Wave 4 圏でコメント/挙動を整合。

## Wave 分割（1 wave = 1 責務 = 1 commit）

- **Wave 1（課題1）**: `taskFilterUtils.computeTaskCounters` に today/myday の未完了行数ベース算出を追加。呼び出し側（TasksPageContainer）で `todayRows` / pinned 情報を渡す。単体テスト更新。
- **Wave 2（課題2）**: `useTaskDataLoader.load` の 2 段階化。Phase A/B 分割、レース保護維持、テスト（Phase A 単独で tasks/today が set され isLoading=false になること、Phase B 失敗が Phase A を壊さないこと）。
- **Wave 3（課題3）**: `searchTasks` 純関数＋テスト、`TaskSearchModal.tsx`、ヘッダー 🔍 追加、コンテナ配線（全タスク取得・結果選択で `selectTask`）。
- **Wave 4（課題4）**: live 再現確認結果に基づく最小修正（silent reload の楽観 status 保持等）。テスト（該当すれば）。
- **Wave 5（課題5＋総合）**: Codex 独立最終レビュー→実欠陥のみ修正。`npx tsc --noEmit` / `npm test`（ui）通過確認。

## テスト戦略
- 各 wave: `cd ui && npx tsc --noEmit` と該当 `*.test.ts(x)`。
- 全体: `ui` の vitest 全通過、可能なら `npm run dev` で Today/検索/Done を手動確認（codex 併用）。

## 触ってよい / 触ってはいけない
- 触ってよい: `ui/src/tasks/**`, `ui/src/lib/api.ts`（検索用の無フィルタ list は既存 `list()` で足りるため原則追加不要）, 関連 `__tests__`。
- 触ってはいけない: `services/**`（API 契約変更なし）, カレンダー/スケジュール描画ロジック（counter 経路以外）, 認証・sync 層。

## ロールバック
- wave 単位 commit のため個別 revert 可能。Phase 分割（Wave 2）はレース回帰リスクがあるため、疑わしければ単 commit revert。

## 進捗ボード
- [x] Wave 1: Today/My Day カウント一致 — commit 7024f35
- [x] Wave 2: 初期表示 2 段階ロード — commit 1a4d538
- [x] Wave 3: 全タスク検索モーダル — commit 300ed5e
- [x] Wave 4: Done 反映ラグ修正（settle epoch ガード） — commit ff7b326
- [x] Wave 5a: 検索の別プロジェクト結果オープン修正＋fetch 世代ガード — commit f5e2074
- [x] Wave 5b: Today 行の project-filter scope＋explicit skipped 非表示＋sort コメント整合 — commit 6baa78d
- [x] 最終検証: `npx tsc --noEmit` OK / ui vitest 全 37 files・230 tests 通過

## 許容制約（最終レビューで許容と判断）
- settle-epoch ガードは背景 refresh 経路のみ。手動 Refresh ボタン（明示操作）と add/save 後の onReload は楽観 status を上書きし得るが、いずれも一時的で trailing refresh により回復するため許容。
- Phase B（wide-range）解決前は planned/overdue/inbox バッジがフィルタ切替直後に旧値を一瞬表示し得る（Inbox の「No Tasks」誤表示のみ isSecondaryLoading で抑止済み）。TTFP 優先で許容。
- untimed の occurrence 行が先頭にソートされる挙動は現状維持（ユーザー確認済みの表示順）。コメントのみ実挙動に整合。
- 検索結果の別プロジェクト選択時は contextFilter をそのタスクのプロジェクトへ切替（ユーザー選択）。
