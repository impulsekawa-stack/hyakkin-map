# 100均マップ(PWA)

近くの100円ショップを地図に表示するスマホ向けWebアプリ。ホーム画面に追加してアプリとして使う想定。
ユーザーへの返答は日本語で書く。

## 決定済みの方針(2026-10-15)
- 作り方: **PWA**(Kotlinネイティブではない)。将来apkが欲しくなったらCapacitorで包む。このPCにAndroid Studio / SDKは未導入。
- データ: **無料のOpenStreetMap**(Overpass API)。Google Placesは使わない(有料・APIキー必要のため)。
- 対象チェーン: ダイソー / セリア / キャンドゥ / ワッツ(ミーツ含む)/ THREEPPY / Standard Products。
- 地図: Leaflet 1.9.4(unpkg)+ OSM標準タイル。

## ファイル構成
- `index.html` … 画面の骨組み(ヘッダー・チェーン絞り込みボタン・地図・下の一覧シート)
- `app.js` … 本体。`CHAINS`(チェーン定義と判定用の正規表現)、`search()`(Overpass検索)、`render()`(ピンと一覧の描画)
- `style.css` / `sw.js`(Service Worker。キャッシュ名を変えると更新される)/ `manifest.webmanifest` / `icons/`(System.Drawingで生成)

## 実装済み
- 現在地の周り1/2/3/5kmを検索。チェーンごとに色分けしたピンを表示し、一覧は距離順。
- チェーンの絞り込み(状態はlocalStorageに保存)、「このエリアで再検索」、ポップアップ(距離・階数・営業時間・Googleマップの徒歩ルート案内)。
- 前回の検索結果をlocalStorageに保存し、次回起動時にすぐ表示する。
- 営業時間を日本語化(`Mo-Su`→`毎日`)、階数を変換(OSMのlevel 0→1階、-1→地下1階)。

## ハマりどころ
- Overpassのメインサーバー(overpass-api.de)は混雑で504を返しやすい。検索条件は**`nwr(around)["shop"]->.s` で先に範囲を絞ってから**name/brandを正規表現で照合すること。逆の順番だとタイムアウトする。
- 予備サーバー(kumi.systems / private.coffee)は2026-10-15時点で応答しなかった。メインへの再試行を優先している。
- 判定順が大事: THREEPPY / Standard Products を、ダイソーより先に判定する。

## ローカルで確認する
- Node製の簡易サーバーを `http://localhost:8123/` で起動して、PCのChromeで見る(スクリプトは会話ごとの一時フォルダにあったので、必要なら作り直す)。
- スマホで位置情報を使うにはHTTPSで公開する必要がある(同じWi-Fiからhttpで開いても位置情報は使えない)。

## 次にやること(未決定)
- **公開先を決める**: GitHub Pages(推奨)/ Netlify Drop / Cloudflare Pages。ユーザーの回答待ち。公開は外部への公開になるので、実行前に確認を取る。
- Superpowersプラグイン(v7.0.0)を導入済み。機能追加はbrainstorming → 計画 → 実装の流れで進めたい意向。
- 追加機能の候補: お気に入り、営業中のみ表示、apk化。
