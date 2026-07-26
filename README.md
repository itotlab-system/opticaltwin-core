# OpticalTwin

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21594827.svg)](https://doi.org/10.5281/zenodo.21594827)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Interactive 3D viewer and editor for **optical laboratory setups**, built on
[OpenUSD](https://openusd.org/) and [React Three Fiber](https://r3f.docs.pmnd.rs/).

Open a shared setup in a browser, place real optical components at physically
correct positions on a breadboard, check fit, spacing and alignment, and discuss
the layout with colleagues — without needing to be in the optics room.

- **Stack:** React + React Three Fiber (frontend) · Flask + OpenUSD (backend) · Git (sync)
- **Conventions:** millimetres · Z-up · optical axis along +X
- **License:** Apache-2.0

## Scope

OpticalTwin is a tool for **layout and planning**, not an optical design suite.
Beam paths are drawn as straight planning lines between components; there is no
ray tracing, refraction or diffraction modelling. A paraxial Gaussian beam-width
calculation (ABCD matrices) is available as an overlay for rough sanity checks
only — it is not a substitute for Zemax, Code V or equivalent.

---

## Quick start

Requires **Python 3.12** and **Node 20**.

```bash
# 1 — Python backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements-app.txt
python setup_projects.py    # generates components/ and an example project
python server.py            # http://localhost:8000

# 2 — React frontend (separate terminal)
cd app
npm install
npm run dev                 # http://localhost:5173
```

Open **http://localhost:5173/**. Vite proxies `/api` and `/model` to the backend.

For a production build, run `npm run build` in `app/` — the backend then serves
`app/dist/` directly on port 8000, and the frontend dev server is not needed.

### The component library is generated

`components/` is **not** checked in. `python setup_projects.py` builds the
catalogue from the `make_*` generators in `optics_lib.py` — lenses, mirrors,
beamsplitters, irises, detectors and so on, dimensioned to common
Ø1″ / 30 mm-cage standards. Re-run it any time to rebuild.

### Using manufacturer CAD models

`cad_importer.py` converts STEP files into USD components. It needs the OpenCASCADE
Python bindings, which are an optional extra (they are large, and only the CAD
import path uses them):

```bash
pip install cadquery-ocp
python cad_importer.py path/to/PART.step --type lens --lod both \
    --component-name MyPart
```

**No manufacturer CAD data is included in this repository.** Vendor-supplied
STEP models are the property of their manufacturer and their licence terms
generally do not permit redistribution. Download the models for the parts you
own from the manufacturer and import them yourself.

### Access control

The server is open by default, which is only appropriate on a trusted network.
Set `OT_PASSWORD` to require a shared-password login:

```bash
OT_PASSWORD='your-password' python server.py
```

Also set `OT_SESSION_SECRET` to a fixed random value in any persistent
deployment, otherwise sessions are invalidated on every restart. The server
speaks plain HTTP — put it behind a reverse proxy with TLS if it is reachable
beyond a LAN.

---

## How it works

USD is the single source of truth. Each optic is its own `.usda` asset in
`components/`; a setup in `projects/<name>/setup.usda` pulls them in via USD
**References**, so one asset can be placed many times. Every edit in the browser
is written straight back to the `.usda` file — the editor holds no hidden state,
and setups are plain text, so they diff and merge in git.

```
OpticalTwin/
├── server.py            # Flask backend — reads/writes USD, serves the REST API
├── optics_lib.py        # component generators and setup helpers
├── templates.py         # named setup recipes
├── setup_projects.py    # scaffolds projects/<name>/setup.usda from a template
├── cad_importer.py      # STEP → USD component conversion
├── beam_tracer.py       # straight-line beam path resolution
├── usd_to_web.py        # setup .usda → .glb (glTF, Y-up)
├── app/                 # React + React Three Fiber frontend
├── web/                 # static viewer / earlier plain-HTML editor
├── components/          # generated component library (not checked in)
└── projects/            # one folder per setup (the live edited state)
```

## Tests

```bash
python -m unittest test_component_library test_beam_tracer test_cad_importer
```

The CAD import tests require `cadquery-ocp` (see above); the rest run with the
base dependencies alone.

---

## Citation

If you use OpticalTwin in your research, please cite it as:

> Kumano, K., Yoshino, K., Goto, M., Matsuo, Y., & Fujima, Y. (2026).
> *OpticalTwin: a browser-based 3D viewer and editor for optical laboratory setups*
> (Version 1.0.0) [Computer software].
> Zenodo. https://doi.org/10.5281/zenodo.21594827

BibTeX:

```bibtex
@software{opticaltwin,
  author  = {Kumano, Kai and Yoshino, Kota and Goto, Masato and Matsuo, Yuto
             and Fujima, Yudai},
  title   = {{OpticalTwin: a browser-based 3D viewer and editor for optical laboratory setups}},
  year    = {2026},
  version = {1.0.0},
  doi     = {10.5281/zenodo.21594827},
  publisher = {Zenodo},
  url     = {https://github.com/itotlab-system/opticaltwin-core}
}
```

See `CITATION.cff` for machine-readable metadata — GitHub renders it as a
"Cite this repository" button.

## Acknowledgements

Developed at the Ito–Shimobaba–Wang Laboratory (ITOT lab.), Graduate School of
Science and Engineering, Chiba University.

---

# OpticalTwin（日本語）

光学実験セットアップの 3D ビューア・エディタです。OpenUSD と React Three Fiber で
構築されています。ブラウザ上で共有セットアップを開き、部品を物理的に正確な位置に
配置し、フィット感・アライメントを確認して議論できます。

- **単位:** ミリメートル · Z軸上向き · 光軸は +X 方向
- **ライセンス:** Apache-2.0

**スコープ:** レイアウトと配置計画のためのツールであり、光学設計ソフトではありません。
ビームは部品間の直線として描画され、光線追跡・屈折・回折の計算は行いません
（近軸ガウシアンビーム幅の概算表示のみ補助的に利用できます）。

## セットアップ

Python 3.12 と Node 20 が必要です。

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements-app.txt
python setup_projects.py    # components/ とサンプルプロジェクトを生成
python server.py            # http://localhost:8000

# 別ターミナルで
cd app && npm install && npm run dev   # http://localhost:5173
```

`components/`（部品カタログ）はリポジトリに含まれていません。`setup_projects.py` が
`optics_lib.py` の `make_*` ジェネレータから生成します。

**メーカー提供の CAD データは同梱していません。** ベンダーの STEP モデルは各社の
著作物であり、再配布は通常許可されていません。お持ちの部品のモデルはメーカーから
各自ダウンロードし、`cad_importer.py` で取り込んでください。

サーバーは既定で認証なしです。共有パスワードによるログインを有効にするには
`OT_PASSWORD` を設定してください。信頼できるネットワーク以外に公開する場合は、
TLS 終端のリバースプロキシを前段に置いてください。

## 引用

研究で使用した場合は、上記 Citation 節の形式、または `CITATION.cff` を参照して
引用してください。DOI は **10.5281/zenodo.21594827** です（常に最新版を指します）。
