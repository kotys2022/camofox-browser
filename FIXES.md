# camofox-browser — список змін (за спаданням впливу)

Виправлення ергономіки й дефолтів, виявлені під реальним агентним навантаженням
(data-екстракція через MCP), а не з рев'ю коду. Кожен пункт: **симптом → доказ →
місце в коді → рішення → пріоритет**. База — upstream **v1.14.0**.

Легенда пріоритету: 🔴 high (б'є по швидкості/надійності агента) · 🟡 medium · 🟢 nice-to-have.

> **Нумерація:** `#1–#8` — ергономіка з агентного навантаження. `#0` — несуча движкова
> зміна ідентичності (persist+inject fingerprint), фундамент для решти.

---

## #0 🔴 Персист + inject fingerprint (`identity.json`) при КОЖНОМУ launch
**Симптом:** профіль не можна завантажити з його ідентифікаторами — движок щоразу
генерує **новий** fingerprint. Після idle-kill (5 хв) / crash / рестарту контейнера
relaunch дає іншу ідентичність → сесія інвалідовується (relogin/detection).
**Доказ:** `launchOptions({os,proxy,geoip,humanize,…})` (`server.js:1120`) **не** передає
ні `fingerprint`, ні `config` → camoufox-js генерує **новий** fp при кожному
`firefox.launch(options)`. Персисту fp нема ніде; `persistence`-плагін зберігає лише
`storageState` (cookies/localStorage/opt-in IndexedDB), не fingerprint. З
`BROWSER_IDLE_TIMEOUT_MS` браузер релончиться **усередині живого контейнера**, не лише на старті.
**Код + seam:** наявний хук `browser:launching { options }` фізично **надто пізній** — `options`
там це вже **результат** `launchOptions()`: fingerprint вливається в `config`
(`utils.js:414` `mergeInto(config, fromBrowserforge(fingerprint))`), додаються seeds, і весь config
серіалізується в env-чанки `CAMOU_CONFIG_*` (`utils.js:548` `getEnvVars`). Повернений об'єкт
**не має** полів `.fingerprint`/`.config` — Camoufox читає `CAMOU_CONFIG_*` з env, тож мутація
`options.fingerprint` у `browser:launching` = **no-op**.
**Рішення:** у ядро додано **пре-хук** `browser:launchOptions { launchArgs }` *перед*
`launchOptions()` (`server.js:1120`), який дає плагінам вписати `fingerprint`/`config` у **вхід**
резолвера (`launchOptions({…fingerprint?, config?})`). Задокументовано в `lib/plugins.js`.
**Фікс:** плагін `plugins/identity/` читає `CAMOFOX_FINGERPRINT_FILE` (дефолт
`<profileDir>/identity.json`) у хуку `browser:launchOptions` при **кожному** launch і ставить
`launchArgs.fingerprint`/`launchArgs.config` (deep-clone — `launchOptions()` мутує config in-place).
`generate:true` → self-generate при першому launch. Тести: `plugins/identity/plugin.test.js`;
E2E — `scripts/verify-identity-e2e.sh` (rebuild образу + idle-kill relaunch у живому контейнері):
POSITIVE — WebGL/navigator/screen ІДЕНТИЧНІ до/після relaunch; NEGATIVE (без плагіна) — WebGL дрейфує.
**Три знахідки з E2E** (не з рев'ю коду): (1) білд Firefox-135 не має `audio:seed`/`canvas:seed`
у `properties.json` → `validateConfig` кидав `UnknownProperty` → плагін фільтрує seeds за схемою
білда (`camoufoxPath(false)`), identity.json лишається портативним суперсетом. (2) `launchOptions()`
щолаунч ре-семплить WebGL і `mergeInto`-перезаписує його поза fingerprint → фікс: персистити
`[vendor,renderer]` (`getPossiblePairs`) і передавати `launchArgs.webgl_config`. (3) `canvas:aaOffset`
camoufox `mergeInto`-перезаписує щолаунч без launch-input override → пінується **пост-резолюшн**
у хуку `browser:launching` (реасембл `CAMOU_CONFIG_*` env-чанків → override → ре-чанк). Підсумок:
**уся поверхня fingerprint (navigator/screen/fonts/WebGL/canvas) стабільна** через idle-kill relaunch.
**Гео-когерентність locale:** fingerprint генерується під локаль країни проксі
(`localeFromCountry(PROXY_COUNTRY)` через вбудований ICU `Intl.Locale.maximize`, `lib/geo-locale.js`)
→ `navigator.language`/`languages`/`Accept-Language` збігаються з гео проксі (timezone/locale/
geolocation/webrtc і так деривуються з exit-IP через geoip щолаунч). Лише коли проксі реально активний.
**Опційне re-home локалі (`CAMOFOX_LOCALE_FOLLOWS_PROXY=1`):** для **персистованого** профілю, який
переїжджає в іншу країну, при кожному launch перезаписуються **лише** `navigator.language`/`languages`
під поточну `PROXY_COUNTRY` (`applyLocaleToFingerprint`, `lib/geo-locale.js`) — решта відбитка стабільна,
диск не чіпається (патч у пам'яті). Off за замовчуванням (зміна мови між сесіями для логін-акаунта —
сама по собі слабкий сигнал; у межах однієї країни — no-op). E2E: identity під en-US + SI-проксі+прапорець
→ браузер віддає `sl-SI`, identity.json на диску лишається `en-US`.
**Персистити обидва шари:** (1) Browserforge `Fingerprint` (navigator/screen/webgl/fonts) +
(2) noise-**seeds** (`audio:seed`/`canvas:seed`/`fonts:spacing_seed`/`window.history.length`/`canvas:aaOffset`)
через `config=` — інакше canvas/audio попливе. **НЕ** персистити IP-exact поля (`webrtc:ipv4`,
точна geolocation): лишати порожніми, `geoip=true` деривує їх з поточного проксі-IP щолаунч (стійкість
до зміни sticky-IP у межах гео).
**Категорії ідентифікаторів:** fingerprint і proxy — **launch-bound** (вшиваються в процес Camoufox
через `CAMOU_CONFIG` при спавні; на живому браузері підмінити НЕ можна — лише relaunch);
cookies/storage — **context-bound** (вантажаться per `newContext`). Ротація іншого профілю на слот =
relaunch (stop → підмінити `identity.json` → start).
**Приорітет:** 🔴 (несуча движкова зміна для всієї ідентичності профілю; решта — довкола неї).

---

## #1 🟡 Уніфікувати активацію плагінів (env-gate мертвий, крім VNC)
**Симптом:** увімкнути плагін через env-змінну неможливо; довелось монтувати власний
`camofox.config.json` зі списком плагінів.
**Доказ:** сервер вантажить лише плагіни зі списку `camofox.config.json` `plugins{}`;
`plugin.json→enableEnvVar` не діє.
**Код:** `pluginEnv` хардкодився ЛИШЕ на `ENABLE_VNC` (loadPlugins викликається без загального
`options.env`). Тому VNC вмикався env-ом, а решта — ні.
**Фікс (ЗРОБЛЕНО):** `config.js` `pluginEnv` більше не хардкодить `{ENABLE_VNC}`, а віддає повний
`process.env` → `loadPlugins` (`lib/plugins.js:156`) читає `plugin.json.enableEnvVar` КОЖНОГО плагіна
проти реального env. Тепер `ENABLE_<PLUGIN>=1` (напр. `ENABLE_IDENTITY=1`) вмикає плагін, якого нема
у списку `plugins{}`. Плагіни й так у цьому процесі → нового доступу до env не з'являється.
Тест: `plugins.test.js`. E2E: `ENABLE_IDENTITY=1` + `plugins:{}` → лог `plugin enabled by environment`.
**Приорітет:** 🟡 (developer-ergonomics; не блокує, але дорого дивує).

## #2 🔴 `evaluate` з проєкцією / лімітом результату
**Симптом:** прогони по **~23 хв**; ходи моделі 2-3.5 хв кожен на роздутому контексті.
**Доказ:** агент через `camofox_evaluate` смикнув величезний JSON → кожен наступний хід тягнув увесь
блоб у контекст. Серверні логи: `evaluate resultType:"string"` (без обмеження розміру).
**Код:** REST `POST /tabs/:id/evaluate` та MCP `camofox_evaluate` — повертали повний результат.
**Фікс (ЗРОБЛЕНО):** опційні `maxBytes` (обрізка з маркером) і/або jq-подібна `projection`
(шлях у результаті). Логіка — `lib/evaluate-projection.js` (unit-тести); server default через
`CAMOFOX_EVALUATE_MAX_RESULT_BYTES`. E2E: projection→піддерево, maxBytes→truncated.
**Приорітет:** 🔴 (прямо здешевлює і прискорює агентні прогони).

## #3 🔴 Первокласний «capture XHR response» тул
**Симптом:** агент вручну пише `fetch(url).then(r=>r.json())` у `evaluate`; ловить CORS/500
і мусить це обробляти сам.
**Доказ:** дані сайту в XHR, не в HTML; ручний fetch крихкий (анонімні endpoints → CORS/NetworkError).
**Фікс (ЗРОБЛЕНО):** тул `camofox_capture_response` (REST `POST /tabs/:id/capture`) — повертає body
першої XHR/fetch-відповіді, що метчить URL-патерн (підрядок або `/regex/`), у межах таймауту; reload
для повторного тригера on-load XHR; реюзає projection/maxBytes (#2). `lib/capture.js` + unit-тести.
E2E: reload-capture, projection, maxBytes, 504 на no-match.
**Приорітет:** 🔴 (типовий патерн для data-екстракції; прибирає цілий клас помилок).

## #4 🔴 Контракт готовності для SPA (`waitFor`)
**Симптом:** `networkidle` на багатьох SPA часто НЕ настає; кожен викликач винаходить readiness наново.
**Код:** `navigate` / `create_tab`.
**Фікс (ЗРОБЛЕНО):** `navigate`/`create_tab` приймають `waitFor: {selector|text|networkQuietMs}` з
fallback-таймаутом; повертають `{matched, waitedMs, timedOut?}`. `lib/wait-for.js` +
`waitForNetworkQuiet` (трекінг request/finished/failed + quiet-window). Timeout НЕ валить навігацію.
E2E: selector/text/networkQuietMs→matched; неіснуючий selector→matched:false+nav ok.
**Приорітет:** 🔴 (надійність навігації на всіх SPA).

## #5 🟡 Дефолтний віртуальний дисплей ≠ 1×1
**Симптом:** headless-прогін і watch-прогін (VNC) — РІЗНІ середовища; не можна чисто змішувати дані.
**Доказ:** базовий camoufox-js Xvfb — `1x1x24`, АЛЕ ядро вже перекриває його на **1280×720**
(`DefaultVirtualDisplay`). Лишалась справжня проблема: розмір був **хардкод**, тож headless (1280×720)
≠ watched VNC (1920×1080) — скріншоти не порівняти.
**Фікс (ЗРОБЛЕНО):** дефолт-роздільність конфігурована через `CAMOFOX_DISPLAY_RESOLUTION`
(`WxH`/`WxHxDepth`, дефолт `1280x720x24`; невалідне → fallback; `lib/display.js`). Лог
`xvfb virtual display started` містить `resolution` (точний і за VNC-override). E2E:
`CAMOFOX_DISPLAY_RESOLUTION=1600x900` → Xvfb `-screen 0 1600x900x24`; garbage→fallback.
**Приорітет:** 🟡 (детермінізм/паритет headless↔watched; впливає на скріншоти).

## #6 🟡 REST `snapshot` без зображення
**Симптом:** через REST-шлях snapshot губиться візуал (скрін).
**Доказ:** REST snapshot **уже** повертає base64 PNG за `?includeScreenshot=true` (три шляхи; MCP
`camofox_snapshot` шле саме цей параметр). Лишався ергономічний сюрприз: агенти тягнуться до
`?screenshot=true`, а код чекав `includeScreenshot` → тихо без картинки.
**Фікс (ЗРОБЛЕНО):** `?screenshot=true` — **аліас** до `includeScreenshot` на ОБОХ snapshot-endpoints
через спільний `wantScreenshot`. openapi документує обидва. E2E: обидва імені → PNG; без прапорця →
без зображення (backward-compat).
**Приорітет:** 🟡 (форензика/скриптовий шлях).

## #7 🟡 Спостережуваність аргументів тулів
**Симптом:** дебаг агента наосліп — не видно, ЩО він виконав.
**Доказ:** логи показують `evaluate` + `resultType`, але НЕ сам `expression`.
**Фікс (ЗРОБЛЕНО):** опційний env `CAMOFOX_LOG_TOOL_ARGS=1` додає `expression` у лог `evaluate`,
пропущений через `lib/redact.js` `redactToolArg`: маскує секрет-подібні пари (`password`/`token`/
`authorization`/`bearer`/`api_key`/`cookie`/`*_key`) і обрізає до 512B (UTF-8-safe). Вимкнено за
замовчуванням (expression може містити чутливе). Тести: `redact.test.js`. E2E: з флагом лог показує
`expression:"...token=\"***\"..."`; без флага — поля нема.
**Приорітет:** 🟡 (developer-experience при дебагу агентів).

## #8 🟢 Пул / keep-warm браузера
**Симптом:** кожна сесія — холодний старт ~10с; на матриці з десятків прогонів набігає.
**Доказ:** браузер idle-закривається через `BROWSER_IDLE_TIMEOUT_MS` (дефолт 5хв), тож прогони,
рознесені ширше за це вікно, холоднішали щоразу.
**Межа:** справжній пул = **N контейнерів** (оркестрація поза движком; браузер — singleton на
контейнер). Тож у движку — лише **keep-warm** одного браузера, не пул.
**Фікс (ЗРОБЛЕНО, движкова половина):** `BROWSER_IDLE_TIMEOUT_MS=0` вмикає keep-warm — (1) не
idle-закривати браузер (гард у `scheduleBrowserIdleShutdown`), (2) **eager re-warm** після
неочікуваного закриття (crash/disconnect/memory) через `browser.on('disconnected')` →
`scheduleBrowserWarmRetry` (backoff-safe), не чекаючи наступного запиту; НЕ re-warm на
`shutdown`/`admin_stop`. Логіка — `lib/keep-warm.js` (unit-тести). Дефолт (5хв idle) — без змін.
E2E: keep-warm=on → браузер лишається connected після drop сесії; off → закривається; kill camoufox
→ авто re-warm без запиту.
**Приорітет:** 🟢 (продуктивність під навантаженням).

## #9 🟢 Імпорт проксі одним рядком (`PROXY_URL`)
**Симптом:** провайдери дають готовий рядок `scheme://user:pass@host:port`, а движок читав лише
розбиті `PROXY_HOST`/`PROXY_PORT`/`PROXY_USERNAME`/`PROXY_PASSWORD` — доводилось бити URL руками.
**Фікс (ЗРОБЛЕНО):** `PROXY_URL` парситься нативним `new URL()` у `lib/config.js`
(`parseProxyUrl`) і наповнює discrete-поля. Особливості:
- **Precedence:** явні `PROXY_*` перекривають розібране з URL — URL це зручний дефолт, який можна
  точково доповнити (напр. лишити URL, але задати `PROXY_COUNTRY`).
- **Обидві стратегії:** `round_robin` (host/port) і `backconnect` (той самий URL → backconnectHost/Port).
- **Схема:** `http`/`https`/`socks5(h)`/`socks4` пробрасується у `server`-URL проксі
  (`lib/proxy.js`); discrete-конфіги лишаються на дефолті `http`.
- **Стійкість:** битий/непідтримуваний URL → `{}` і фолбек на discrete-змінні, launch не падає.
- Креденшели percent-декодуються.
Unit: `tests/unit/proxyUrl.test.js` (чиста функція, зелена на хості). E2E: `PROXY_URL=...` →
tab → `ipify` через проксі.
**Приорітет:** 🟢 (ергономіка конфіга).

## #10 🟡 Пул проксі зі списку (`PROXY_URLS` / `CAMOFOX_PROXY_LIST_FILE`)
**Симптом:** `round_robin` пулить лише один хост із кількома портами, backconnect — один шлюз.
Не було способу дати **список різних** `scheme://user:pass@host:port` і ротувати їх per-session
(масовий парсинг з IP-різноманіттям).
**Фікс (ЗРОБЛЕНО):** нова мода **`list`** у `createProxyPool` (`lib/proxy.js`), що активується коли
задано `PROXY_URLS` (розділювач — новий рядок/кома) або `CAMOFOX_PROXY_LIST_FILE` (по URL на рядок,
`#`-коментарі). Особливості:
- `parseProxyList` (`lib/config.js`) парсить кожен запис через `parseProxyUrl`, дедуп за
  `scheme://host:port`, битий/непідтримуваний рядок пропускається, відсутній файл ігнорується.
- **`getNext`** ротує пул per-context (userId) — сідає на наявний seam `server.js`; **`getLaunchProxy`**
  ротує по спробах (`launchRetries=min(N,10)`), тож мертвий endpoint ретраїться наступним.
- **Одна країна на пул** (geoip launch-bound; змішування країн → неузгоджені tz/locale для
  off-country контекстів).
- Явна `PROXY_STRATEGY=backconnect` має пріоритет над авто-`list`.
- **Заодно фікс латентного бага:** guard дефолтної локалі в `server.js` був `!CONFIG.proxy.host`,
  що для backconnect/list (де `host` порожній) помилково пінив en-US/LA поверх geoip → змінено на
  `!proxyPool`.
Unit: `tests/unit/proxyList.test.js` (пул + loadConfig, зелені на хості). E2E: `PROXY_URLS=...` →
`mode:list`, tab → exit-IP проксі, tz з geoip (Ljubljana), per-context proxy assigned.
**Приорітет:** 🟡 (фундамент для proxy-менеджера / масового парсингу).

## Дрібне
- **trace.zip** осідає в дефолтному `~/.camofox/traces/` → губиться на `--rm` без volume.
  **ЗРОБЛЕНО:** одноразовий warn при першому трейсі, якщо `CAMOFOX_TRACES_DIR` не заданий явно
  (дефолт-шлях ефемерний) — з remediation. `config.js:tracesDirExplicit`. E2E: дефолт→warn;
  explicit+mount→тиша.

---

## Верифікація
Кожен фікс: чиста логіка в `lib/*` з unit-тестами → server.js/MCP wiring → openapi regen →
живий E2E у Docker. Повний набір сьютів проходить у CI-паритетному образі (`Dockerfile.test`):
**75 suites / 912 тестів, 0 failed**.
