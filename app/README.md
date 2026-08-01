# OpticalTwin — web app (React + React Three Fiber)

The frontend for the optical-setup layout editor. Talks to the Python backend (`../server.py`), which is the only thing that reads/writes USD — **USD stays the source of truth**.

## Prerequisites

Node.js 20+ (Ubuntu does not ship it by default):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # should print v20.x
```

## Run (development)

Two terminals from the repo root:

```bash
# Terminal 1 — backend
source .venv/bin/activate
python server.py           # http://localhost:8000

# Terminal 2 — frontend
cd app
npm install                # first time only
npm run dev                # http://localhost:5173
```

Open **http://localhost:5173/**. Vite proxies `/api` and `/model` to the backend — no CORS issues.

### One-command alternative

From `app/`, with the venv already set up at `../.venv`:

```bash
npm run dev:all
```

This runs `npm run build` first (type-check + production build, fails fast on errors), then starts the backend and the Vite dev server together via `concurrently`.

## Build for the lab server

```bash
cd app && npm run build    # outputs app/dist/
```

The backend serves `app/dist/` automatically in production. See `../README.md`.

## Features

- **3D viewport** — React Three Fiber, Z-up (matches USD units in mm), OrbitControls, HDRI lighting
- **Beam width** button — toggles Gaussian beam simulation (ABCD paraxial, server-side)
- **Outliner** — collapsible component tree grouped by optical-element type
- **Inspector** — numeric X/Y/Z/rotZ fields + component properties + physics panel
- **Grouping** — Ctrl/Cmd+click to multi-select, `Ctrl+G` to group, `Ctrl+Shift+G`
  to ungroup. Clicking a grouped part selects the whole group and moving or
  rotating it keeps the members rigid; double-click drills in to edit one part,
  `Esc` steps back out. Membership is stored in the USD layer (`optics:groups`).
- **Optimistic editing** — moves update the 3D immediately, then POST to backend

## Source layout

```
src/
  App.tsx               # state, layout, optimistic edits
  api.ts                # REST client
  types.ts              # shared TypeScript interfaces
  groups.ts             # selection rules + rigid-body group maths (pure)
  scene/
    Viewport.tsx        # R3F canvas (lighting, controls, postprocessing)
    Component3D.tsx     # per-component 3D mesh
    Beam.tsx            # planning polyline (geometry only)
    ParaxialBeam.tsx    # Gaussian beam width tubes (physics mode)
    Breadboard.tsx      # hole grid
    GroupOutline.tsx    # dashed box + label around a group
  ui/
    Outliner.tsx        # component tree
    Inspector.tsx       # numeric editor + beam pin controls
    GroupInspector.tsx  # multi-selection panel (rename, nudge, ungroup)
    PhysicsPanel.tsx    # paraxial simulation results table
    ProjectGallery.tsx  # landing page
  theme.css             # dark engineering theme
```

---

---

# OpticalTwin — ウェブアプリ（React + React Three Fiber）

光学セットアップエディタのフロントエンドです。Python バックエンド（`../server.py`）と通信します。USD の読み書きはバックエンドのみが行います — **USDがシステムの唯一の情報源です。**

## 必要環境

Node.js 20以上（Ubuntuには標準でインストールされていません）:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # v20.x と表示されればOK
```

## 起動（開発環境）

リポジトリのルートで2つのターミナルを開いてください:

```bash
# ターミナル1 — バックエンド
source .venv/bin/activate
python server.py           # http://localhost:8000

# ターミナル2 — フロントエンド
cd app
npm install                # 初回のみ
npm run dev                # http://localhost:5173
```

**http://localhost:5173/** をブラウザで開いてください。ViteがAPIリクエストをバックエンドに転送します。

### 一括起動コマンド

`../.venv` が既にセットアップ済みであれば、`app/` ディレクトリで:

```bash
npm run dev:all
```

`npm run build`（型チェック + 本番ビルド、失敗時は即エラー終了）を先に実行してから、`concurrently` でバックエンドとVite開発サーバーを同時に起動します。

## ラボサーバー用ビルド

```bash
cd app && npm run build    # app/dist/ に出力されます
```

本番環境ではバックエンドが `app/dist/` を自動的に提供します。詳細は `../README.md` を参照してください。

## 機能一覧

- **3Dビューポート** — React Three Fiber、Z軸上向き（USDのmm単位に合わせた設定）、OrbitControls、HDRIライティング
- **Beam width ボタン** — ガウシアンビームシミュレーションの切り替え（ABCDパラキシャル、サーバー側で計算）
- **Outliner** — 光学素子の種類ごとに折りたためるコンポーネントツリー
- **Inspector** — X/Y/Z/rotZ の数値入力、コンポーネントプロパティ、物理パネル
- **グループ化** — Ctrl/Cmd+クリックで複数選択、`Ctrl+G` でグループ化、
  `Ctrl+Shift+G` で解除。グループ内の部品をクリックするとグループ全体が選択され、
  移動・回転しても相対位置は保たれます。ダブルクリックでグループ内に入って
  個別編集、`Esc` で戻ります。グループ情報は USD（`optics:groups`）に保存されます。
- **楽観的編集** — 3Dはすぐに更新し、その後バックエンドにPOSTで送信

## ソース構成

```
src/
  App.tsx               # 状態管理・レイアウト・楽観的編集
  api.ts                # REST クライアント
  types.ts              # TypeScript インターフェース
  scene/
    Viewport.tsx        # R3F キャンバス（ライティング・コントロール）
    Component3D.tsx     # コンポーネントの3Dメッシュ
    Beam.tsx            # ビーム計画ライン（ジオメトリのみ）
    ParaxialBeam.tsx    # ガウシアンビーム幅チューブ（物理モード）
    Breadboard.tsx      # ホールグリッド
  ui/
    Outliner.tsx        # コンポーネントツリー
    Inspector.tsx       # 数値エディタ・ビームピンコントロール
    PhysicsPanel.tsx    # パラキシャルシミュレーション結果テーブル
    ProjectGallery.tsx  # ランディングページ
  theme.css             # ダークエンジニアリングテーマ
```
