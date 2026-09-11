/**
 * 言語フィルタで選べる言語。
 *
 * Bluesky が投稿の言語として扱うのと同じ ISO 639-1 の一覧 (184 件)。
 * 名前は Node のフル ICU (Intl.DisplayNames) で生成して埋め込んである。
 * ブラウザの ICU は搭載データが小さく、少数言語の名前を解決できないため、
 * 実行時に引くと環境によってコードのまま出たり並び順が崩れたりする。
 *
 * 並びは「よく使う 8 言語 → 日本語名の五十音順」で固定済み。
 * 判定と保存は基底のサブタグで行う (`en` を選べば `en-US` の投稿も拾う)。
 *
 * 更新するときは次のスクリプトで表を作り直す (Node のフル ICU が要る):
 *   node scripts/build-lang-table.mjs
 */

/** [コード, 日本語名, 英語名 / 自言語名] の順。並びは表示順そのもの。 */
const LANG_TABLE = [
  ["ja", "日本語", "Japanese"],
  ["en", "英語", "English"],
  ["ko", "韓国語", "Korean / 한국어"],
  ["zh", "中国語", "Chinese / 中文"],
  ["es", "スペイン語", "Spanish / español"],
  ["pt", "ポルトガル語", "Portuguese / português"],
  ["fr", "フランス語", "French / français"],
  ["de", "ドイツ語", "German / Deutsch"],
  ["is", "アイスランド語", "Icelandic / íslenska"],
  ["ay", "アイマラ語", "Aymara"],
  ["ga", "アイルランド語", "Irish / Gaeilge"],
  ["av", "アヴァル語", "Avaric"],
  ["ae", "アヴェスタ語", "Avestan"],
  ["ak", "アカン語", "Akan"],
  ["tw", "アカン語", "Akan"],
  ["az", "アゼルバイジャン語", "Azerbaijani / azərbaycan"],
  ["as", "アッサム語", "Assamese / অসমীয়া"],
  ["aa", "アファル語", "Afar"],
  ["ab", "アブハズ語", "Abkhazian"],
  ["af", "アフリカーンス語", "Afrikaans"],
  ["am", "アムハラ語", "Amharic / አማርኛ"],
  ["an", "アラゴン語", "Aragonese"],
  ["ar", "アラビア語", "Arabic / العربية"],
  ["sq", "アルバニア語", "Albanian / shqip"],
  ["hy", "アルメニア語", "Armenian / հայերեն"],
  ["it", "イタリア語", "Italian / italiano"],
  ["yi", "イディッシュ語", "Yiddish / ייִדיש"],
  ["io", "イド語", "Ido"],
  ["iu", "イヌクティトット語", "Inuktitut"],
  ["ik", "イヌピアック語", "Inupiaq"],
  ["ig", "イボ語", "Igbo"],
  ["ie", "インターリング", "Interlingue"],
  ["ia", "インターリングア", "Interlingua / interlingua"],
  ["id", "インドネシア語", "Indonesian / Indonesia"],
  ["ug", "ウイグル語", "Uyghur / ئۇيغۇرچە"],
  ["cy", "ウェールズ語", "Welsh / Cymraeg"],
  ["vo", "ヴォラピュク語", "Volapük"],
  ["wo", "ウォロフ語", "Wolof"],
  ["uk", "ウクライナ語", "Ukrainian / українська"],
  ["uz", "ウズベク語", "Uzbek / o‘zbek"],
  ["ur", "ウルドゥー語", "Urdu / اردو"],
  ["ee", "エウェ語", "Ewe / eʋegbe"],
  ["et", "エストニア語", "Estonian / eesti"],
  ["eo", "エスペラント語", "Esperanto"],
  ["oj", "オジブウェー語", "Ojibwa"],
  ["os", "オセット語", "Ossetic / ирон"],
  ["oc", "オック語", "Occitan / occitan"],
  ["or", "オディア語", "Odia / ଓଡ଼ିଆ"],
  ["nl", "オランダ語", "Dutch / Nederlands"],
  ["om", "オロモ語", "Oromo / Oromoo"],
  ["kk", "カザフ語", "Kazakh / қазақ тілі"],
  ["ks", "カシミール語", "Kashmiri / کٲشُر"],
  ["ca", "カタロニア語", "Catalan / català"],
  ["kr", "カヌリ語", "Kanuri"],
  ["gl", "ガリシア語", "Galician / galego"],
  ["lg", "ガンダ語", "Ganda / Luganda"],
  ["kn", "カンナダ語", "Kannada / ಕನ್ನಡ"],
  ["ki", "キクユ語", "Kikuyu / Gikuyu"],
  ["rw", "キニアルワンダ語", "Kinyarwanda / Ikinyarwanda"],
  ["el", "ギリシャ語", "Greek / Ελληνικά"],
  ["ky", "キルギス語", "Kyrgyz / кыргызча"],
  ["gn", "グアラニー語", "Guarani"],
  ["gu", "グジャラート語", "Gujarati / ગુજરાતી"],
  ["km", "クメール語", "Khmer / ខ្មែរ"],
  ["kl", "グリーンランド語", "Kalaallisut / kalaallisut"],
  ["cr", "クリー語", "Cree"],
  ["ku", "クルド語", "Kurdish / kurdî (kurmancî)"],
  ["hr", "クロアチア語", "Croatian / hrvatski"],
  ["kj", "クワニャマ語", "Kuanyama"],
  ["qu", "ケチュア語", "Quechua / Runasimi"],
  ["kw", "コーンウォール語", "Cornish / kernewek"],
  ["xh", "コサ語", "Xhosa / IsiXhosa"],
  ["kv", "コミ語", "Komi"],
  ["co", "コルシカ語", "Corsican"],
  ["kg", "コンゴ語", "Kongo"],
  ["sm", "サモア語", "Samoan"],
  ["sc", "サルデーニャ語", "Sardinian / sardu"],
  ["sg", "サンゴ語", "Sango / Sängö"],
  ["sa", "サンスクリット語", "Sanskrit / संस्कृत भाषा"],
  ["jv", "ジャワ語", "Javanese / Jawa"],
  ["ka", "ジョージア語", "Georgian / ქართული"],
  ["sn", "ショナ語", "Shona / chiShona"],
  ["sd", "シンド語", "Sindhi / سنڌي"],
  ["si", "シンハラ語", "Sinhala / සිංහල"],
  ["sv", "スウェーデン語", "Swedish / svenska"],
  ["zu", "ズールー語", "Zulu / isiZulu"],
  ["gd", "スコットランド・ゲール語", "Scottish Gaelic / Gàidhlig"],
  ["sk", "スロバキア語", "Slovak / slovenčina"],
  ["sl", "スロベニア語", "Slovenian / slovenščina"],
  ["ss", "スワジ語", "Swati"],
  ["sw", "スワヒリ語", "Swahili / Kiswahili"],
  ["su", "スンダ語", "Sundanese / Basa Sunda"],
  ["sr", "セルビア語", "Serbian / српски"],
  ["so", "ソマリ語", "Somali / Soomaali"],
  ["dz", "ゾンカ語", "Dzongkha / རྫོང་ཁ"],
  ["th", "タイ語", "Thai / ไทย"],
  ["tg", "タジク語", "Tajik / тоҷикӣ"],
  ["tt", "タタール語", "Tatar / татар"],
  ["ty", "タヒチ語", "Tahitian"],
  ["ta", "タミル語", "Tamil / தமிழ்"],
  ["cs", "チェコ語", "Czech / čeština"],
  ["ce", "チェチェン語", "Chechen / нохчийн"],
  ["bo", "チベット語", "Tibetan / བོད་སྐད་"],
  ["ch", "チャモロ語", "Chamorro"],
  ["cv", "チュヴァシ語", "Chuvash / чӑваш чӗлхи"],
  ["za", "チワン語", "Zhuang / Vahcuengh"],
  ["ts", "ツォンガ語", "Tsonga"],
  ["tn", "ツワナ語", "Tswana / Setswana"],
  ["ti", "ティグリニア語", "Tigrinya / ትግርኛ"],
  ["dv", "ディベヒ語", "Divehi"],
  ["te", "テルグ語", "Telugu / తెలుగు"],
  ["da", "デンマーク語", "Danish / dansk"],
  ["tk", "トルクメン語", "Turkmen / türkmen dili"],
  ["tr", "トルコ語", "Turkish / Türkçe"],
  ["to", "トンガ語", "Tongan / lea fakatonga"],
  ["na", "ナウル語", "Nauru"],
  ["nv", "ナバホ語", "Navajo"],
  ["ny", "ニャンジャ語", "Nyanja"],
  ["ne", "ネパール語", "Nepali / नेपाली"],
  ["no", "ノルウェー語", "Norwegian / norsk"],
  ["nn", "ノルウェー語(ニーノシュク)", "Norwegian Nynorsk / norsk nynorsk"],
  ["nb", "ノルウェー語(ブークモール)", "Norwegian Bokmål / norsk bokmål"],
  ["pi", "パーリ語", "Pali"],
  ["ht", "ハイチ・クレオール語", "Haitian Creole"],
  ["ha", "ハウサ語", "Hausa"],
  ["ba", "バシキール語", "Bashkir / башҡорт"],
  ["ps", "パシュトゥー語", "Pashto / پښتو"],
  ["eu", "バスク語", "Basque / euskara"],
  ["hu", "ハンガリー語", "Hungarian / magyar"],
  ["pa", "パンジャブ語", "Punjabi / ਪੰਜਾਬੀ"],
  ["bm", "バンバラ語", "Bambara / bamanakan"],
  ["bi", "ビスラマ語", "Bislama"],
  ["ho", "ヒリモツ語", "Hiri Motu"],
  ["hi", "ヒンディー語", "Hindi / हिन्दी"],
  ["fj", "フィジー語", "Fijian"],
  ["tl", "フィリピノ語", "Filipino"],
  ["fi", "フィンランド語", "Finnish / suomi"],
  ["fo", "フェロー語", "Faroese / føroyskt"],
  ["ff", "フラ語", "Fula / Pulaar"],
  ["bg", "ブルガリア語", "Bulgarian / български"],
  ["br", "ブルトン語", "Breton / brezhoneg"],
  ["vi", "ベトナム語", "Vietnamese / Tiếng Việt"],
  ["he", "ヘブライ語", "Hebrew / עברית"],
  ["be", "ベラルーシ語", "Belarusian / беларуская"],
  ["fa", "ペルシア語", "Persian / فارسی"],
  ["hz", "ヘレロ語", "Herero"],
  ["bn", "ベンガル語", "Bangla / বাংলা"],
  ["ve", "ベンダ語", "Venda"],
  ["bh", "ボージュプリー語", "Bhojpuri"],
  ["pl", "ポーランド語", "Polish / polski"],
  ["bs", "ボスニア語", "Bosnian / bosanski"],
  ["mh", "マーシャル語", "Marshallese"],
  ["mi", "マオリ語", "Māori"],
  ["mk", "マケドニア語", "Macedonian / македонски"],
  ["mg", "マダガスカル語", "Malagasy"],
  ["mr", "マラーティー語", "Marathi / मराठी"],
  ["ml", "マラヤーラム語", "Malayalam / മലയാളം"],
  ["mt", "マルタ語", "Maltese / Malti"],
  ["ms", "マレー語", "Malay / Melayu"],
  ["gv", "マン島語", "Manx / Gaelg"],
  ["my", "ミャンマー語", "Burmese / မြန်မာ"],
  ["mn", "モンゴル語", "Mongolian / монгол"],
  ["yo", "ヨルバ語", "Yoruba / Èdè Yorùbá"],
  ["lo", "ラオ語", "Lao / ລາວ"],
  ["la", "ラテン語", "Latin"],
  ["lv", "ラトビア語", "Latvian / latviešu"],
  ["lt", "リトアニア語", "Lithuanian / lietuvių"],
  ["ln", "リンガラ語", "Lingala / lingála"],
  ["li", "リンブルフ語", "Limburgish"],
  ["ro", "ルーマニア語", "Romanian / română"],
  ["lb", "ルクセンブルク語", "Luxembourgish / Lëtzebuergesch"],
  ["lu", "ルバ・カタンガ語", "Luba-Katanga / Tshiluba"],
  ["rn", "ルンディ語", "Rundi / Ikirundi"],
  ["ru", "ロシア語", "Russian / русский"],
  ["rm", "ロマンシュ語", "Romansh / rumantsch"],
  ["wa", "ワロン語", "Walloon"],
  ["ng", "ンドンガ語", "Ndonga"],
  ["cu", "教会スラブ語", "Church Slavic"],
  ["ii", "四川イ語", "Sichuan Yi / ꆈꌠꉙ"],
  ["fy", "西フリジア語", "Western Frisian / Frysk"],
  ["nr", "南ンデベレ語", "South Ndebele"],
  ["st", "南部ソト語", "Southern Sotho / Sesotho"],
  ["se", "北サーミ語", "Northern Sami / davvisámegiella"],
  ["nd", "北ンデベレ語", "North Ndebele / isiNdebele"],
];

/** ISO 639-1 の言語コード (表示順)。 */
export const LANG_CODES = LANG_TABLE.map((row) => row[0]);

const BY_CODE = new Map(LANG_TABLE.map((row) => [row[0], row]));

/** 表示用の名前 (日本語)。一覧に無いコードはそのまま返す。 */
export function langLabel(code) {
  const row = BY_CODE.get(code);
  return row ? row[1] : code || '';
}

/**
 * 一覧に出す言語。
 * `selected` に一覧外のコードが入っていても落とさず末尾に足す。
 */
export function listLangs(selected = []) {
  const rows = LANG_TABLE.concat(
    selected.filter((code) => !BY_CODE.has(code)).map((code) => [code, code, ''])
  );
  return rows.map(([code, label, sub]) => ({
    code,
    label,
    sub,
    search: (code + ' ' + label + ' ' + sub).toLowerCase(),
  }));
}

/** `en-US` → `en`。比較と保存はこの形で行う。 */
export function normalizeLang(tag) {
  return (tag || '').trim().toLowerCase().split('-')[0] || '';
}
