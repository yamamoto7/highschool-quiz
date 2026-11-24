# 出身高校、当てます。

「海は見えましたか」「坂をのぼった先にありましたか」のような質問に はい／いいえ で答えると、
全国約5,000校から出身高校を言い当てるアキネーター型ゲーム。プレイ中は LLM も外部 API も使わず、
ブラウザ内のベイズ推定だけで動く。

```bash
npm run dev        # http://localhost:3000
npm run simulate   # 自己対戦で的中率・質問数を測る（例: npm run simulate -- 500 / -- 3 trace）
npm run data       # 地形・立地データを作り直す → public/data/schools.json
npm run map        # 学校まわりの地物（田・茶畑・寺社・川・高速道路など）を地理院地図から集計して反映
npm run wiki       # Wikipedia 由来の学校情報を取得・抽出して反映（初回は制限のため1〜2時間。キャッシュあり）
```

## しくみ

- `scripts/build-data.mjs` … 公開データから学校ごとの「事実」を事前計算（標高、周囲との高低差、海までの距離、
  海や山が見通せるか、最寄り駅、周辺の市街地度など）→ `public/data/schools.json`
- `scripts/fetch-wiki.mjs` / `scripts/build-wiki.mjs` … 各校の Wikipedia 記事から、宗教系統・課程・学科・創立年・全国大会の出場歴、
  本文中の部活・行事・施設・卒業生などの記述を抽出 → `data/wiki.json`（`schools.json` にも反映）
- `scripts/build-bvmap.mjs` … 地理院地図のベクトルタイルから、学校の半径800mにある地図記号・水面・高速道路を集計 → `data/bvmap.json`
- `lib/question-ranks.json` … 質問の手動ランク（S/A/B/C/D、X は出題しない）。`lib/questions.ts` の優先度を上書きする
- `lib/questions.ts` … 質問の定義。事実から「出身者が『はい』と答える確率」を決める。**質問の追加・調整はここ**
- `lib/engine.ts` … 事後確率の更新と、次の質問選び（期待情報量 × ドキドキ度 `drama`）
- `components/Game.tsx` … 画面

出題は「風景・体感 → 土地柄・学校の種類 → 校名の漢字・最寄り駅（決め手）」の順に解禁される（`minAsked` / `maxEff`）。

## データの作り直し

`data/raw/` に以下を置いて `npm run data`（標高タイルは自動で取得し `data/cache/` にキャッシュ）。

- `P29-21.geojson` … [国土数値情報 学校データ](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P29-v3_0.html)（令和3年度）
- `N02-22_Station.geojson` … [国土数値情報 鉄道データ](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-v3_1.html)（令和4年度、UTF-8版）
- 標高 … [地理院タイル dem_png](https://maps.gsi.go.jp/development/ichiran.html)

出典: 国土数値情報（国土交通省）／地理院タイル（国土地理院）を加工して作成。学校情報の一部は Wikipedia 日本語版（CC BY-SA）の記事をもとに抽出。
