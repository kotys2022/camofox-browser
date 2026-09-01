# camofox-browser — список фіксів (за спаданням впливу)

Джерело: реальне агентне навантаження з CryptoRank Extraction Harness (`/srv/work/testCamofox`),
2026-09-01. Кожен пункт: **симптом → доказ → місце в коді (образ) → пропозиція → пріоритет**.
Місця в коді — шляхи всередині `camofox-browser:local` (сорсу тут ще нема, звірити після клону).

Легенда пріоритету: 🔴 high (б'є по швидкості/надійності агента) · 🟡 medium · 🟢 nice-to-have.

> **Нумерація:** `#1–#8` — із harness-навантаження (ергономіка). `#0` — движкова
> зміна ідентичності (ADR Open Question **#12**), перенесена сюди з
> `BotoFerma/docs` (ADR §36 #12, §3; `SPEC-002-profile-provisioning`;
> `SPEC-camofox-pool-pattern-A` §6). SPEC-и трактують її як зовнішню залежність
> «движок (#12, окремо)» — а цей репозиторій і є місцем, де її роблять.

---

## #0 🔴 Персист + inject fingerprint (`identity.json`) при КОЖНОМУ launch — Open Question #12
**Симптом:** профіль не можна завантажити з його ідентифікаторами — движок щоразу
генерує **новий** fingerprint. Після idle-kill (5 хв) / crash / рестарту контейнера
relaunch дає іншу ідентичність → платформа інвалідовує сесію (relogin/detection),
ламається immutable-інваріант Profile (ADR §3).
**Доказ (звірено з клоном upstream — увага: тепер `v1.14.0`, docs аналізували образ
`v1.6.0`; механізм **не** змінився):** `launchOptions({os,proxy,geoip,humanize,…})`
(`server.js:1120`) **не** передає ні `fingerprint`, ні `config` → camoufox-js генерує
**новий** fp при кожному `firefox.launch(options)` (`server.js:1143`). Персисту fp нема
ніде: `grep FINGERPRINT_FILE|identity.json|fromBrowserforge` → 0 збігів; `persistence`-плагін
зберігає лише `storageState` (cookies/localStorage/opt-in IndexedDB — `plugins/persistence/README.md`),
не fingerprint. З `BROWSER_IDLE_TIMEOUT_MS` браузер релончиться **усередині живого
контейнера**, не лише на старті.
**Код + seam (ЗВІРЕНО з v1.14.0 — попередній план був хибний):** наявний хук
`browser:launching { options }` (`server.js:1141`) фізично **надто пізній**. `options` там —
це вже **результат** `launchOptions()` (1120→1130): fingerprint вливається в `config`
(`utils.js:414` `mergeInto(config, fromBrowserforge(fingerprint))`), додаються seeds
(`utils.js:426-433`), і весь config серіалізується в env-чанки `CAMOU_CONFIG_*`
(`utils.js:548` `getEnvVars`). Повернений об'єкт **не має** полів `.fingerprint`/`.config` —
Camoufox читає `CAMOU_CONFIG_*` з env, тож мутація `options.fingerprint` у `browser:launching`
= **no-op**. Тому «без правок ядра» **неможливо**.
**Рішення (реалізовано, path A):** у ядро додано **пре-хук** `browser:launchOptions { launchArgs }`
*перед* `launchOptions()` (`server.js:1120`), який дає плагінам вписати `fingerprint`/`config`
у **вхід** резолвера (офіційні параметри `camoufox-js`: `launchOptions({…fingerprint?, config?})`,
`utils.d.ts:68-71`; `dist/fingerprints.d.ts` → `generateFingerprint`/`fromBrowserforge`).
Задокументовано в `lib/plugins.js` (мутуючий хук поряд з `browser:launching`, `session:creating`).
**Фікс:** плагін `plugins/identity/` читає `CAMOFOX_FINGERPRINT_FILE` (дефолт `<profileDir>/identity.json`)
у хуку `browser:launchOptions` при **кожному** launch і ставить `launchArgs.fingerprint`/`launchArgs.config`
(deep-clone — `launchOptions()` мутує config in-place). `generate:true` → self-generate при першому
launch (SPEC-002 варіант A). Тести: `plugins/identity/plugin.test.js` (генерація+реюз стабільний,
no-clobber, generate=false fallback, schema-фільтр seeds; E2E-стабільність `CAMOU_CONFIG` за `RUN_LIVE_TESTS`).
**E2E ЗВІРЕНО наживо** (`scripts/verify-identity-e2e.sh`, rebuild образу + idle-kill relaunch у
живому контейнері): POSITIVE — WebGL/navigator/screen ІДЕНТИЧНІ до/після relaunch (хук ×2);
NEGATIVE (без плагіна) — WebGL дрейфує NVIDIA→AMD (контроль доводить, що проб ловить дрейф).
**Дві знахідки з E2E** (не з рев'ю коду): (1) білд Firefox-135 не має `audio:seed`/`canvas:seed`
у `properties.json` → `validateConfig` кидав `UnknownProperty` → плагін фільтрує seeds за схемою
білда (`camoufoxPath(false)`), identity.json лишається портативним суперсетом. (2) `launchOptions()`
щолаунч ре-семплить WebGL і `mergeInto`-перезаписує його поза fingerprint → персист fingerprint
НЕ пінує WebGL; фікс — персистити `[vendor,renderer]` (`getPossiblePairs`) і передавати
`launchArgs.webgl_config`. (3) `canvas:aaOffset` camoufox `mergeInto`-перезаписує щолаунч без
launch-input override → пінується **пост-резолюшн** у хуку `browser:launching` (реасембл
`CAMOU_CONFIG_*` env-чанків → override → ре-чанк). Підсумок E2E: **уся поверхня fingerprint
(navigator/screen/fonts/WebGL/canvas) стабільна** через idle-kill relaunch (POSITIVE ідентично,
NEGATIVE-контроль дрейфує).
Персистити **обидва шари**: (1) Browserforge `Fingerprint` (navigator/screen/webgl/fonts) +
(2) noise-**seeds** (`audio:seed`, `canvas:seed`, `fonts:spacing_seed`, `window.history.length`)
через `config=` — інакше canvas/audio попливе (seeds рандомізуються щолаунч через
`setInto`=set-only-if-unset). **НЕ** персистити IP-exact поля (`webrtc:ipv4`, точна geolocation):
лишати порожніми, `geoip=true` деривує їх з поточного проксі-IP щолаунч (стійкість до зміни
sticky-IP у межах гео — SPEC-002 §6.1). Провіженинг файла — SPEC-002 варіант (A) self-generate
(`generateFingerprint()` у provisioner) або (B) capture-on-first-launch (потребує ще й dump-хука).
**Категорії ідентифікаторів:** fingerprint і proxy — **launch-bound** (вшиваються в процес
Camoufox через `CAMOU_CONFIG` при спавні; на живому браузері підмінити НЕ можна — лише
relaunch); cookies/storage (Layer-C) — **context-bound** (вантажаться per `newContext`).
Ротація іншого Profile на слот = relaunch (stop → підмінити `identity.json` → start).
**Блокує:** ADR §3 immutability; SPEC-002 A2/A3 (persist→restore, когерентність);
стабільність fingerprint у пулі (SPEC-pool §6). До фіксу навіть статичний слот «пливе»
після простою.
**Приорітет:** 🔴 (несуча движкова зміна для всієї Profile-ідентичності; решта — довкола неї).

---

## #1 🟡 Уніфікувати активацію плагінів (env-gate мертвий, крім VNC)
**Симптом:** увімкнути `cr-fixture` через env-змінну неможливо; довелось монтувати власний
`camofox.config.json` зі списком плагінів.
**Доказ:** сервер вантажить лише плагіни зі списку `camofox.config.json` `plugins{}`;
`plugin.json→enableEnvVar` не діє.
**Код:** `config.js:145-146` — `pluginEnv` хардкодиться ЛИШЕ на `ENABLE_VNC` (loadPlugins
викликається без загального `options.env`). Тому VNC вмикається env-ом, а решта — ні.
**Фікс:** прокинути env уніфіковано — для КОЖНОГО плагіна читати його `plugin.json.enableEnvVar`,
а не хардкодити один VNC. Тоді `CR_FIXTURE=1` / `ENABLE_<PLUGIN>=1` працюватимуть однаково.
**Приорітет:** 🟡 (developer-ergonomics; не блокує, але дорого дивує).

## #2 🔴 `evaluate` з проєкцією / лімітом результату
**Симптом:** прогони по **~23 хв**; ходи моделі 2-3.5 хв кожен на роздутому контексті.
**Доказ:** агент через `camofox_evaluate` смикнув masked `pageProps` (величезний JSON) →
кожен наступний хід тягнув увесь блоб у контекст. Серверні логи: `evaluate resultType:"string"`
(без обмеження розміру).
**Код:** REST `POST /tabs/:id/evaluate` та MCP `camofox_evaluate` — повертають повний результат.
**Фікс:** додати опційні `maxBytes` (обрізати з маркером) і/або jq-подібну `projection`
(шлях у результаті), щоб віддавати лише потрібне, не заливаючи контекст агента.
**Приорітет:** 🔴 (прямо здешевлює і прискорює агентні прогони).

## #3 🔴 Первокласний «capture XHR response» тул
**Симптом:** агент вручну пише `fetch(url).then(r=>r.json())` у `evaluate`; на `/exclusive`
ловить CORS/500 і мусить це обробляти сам.
**Доказ:** дані сайту в XHR, не в HTML; ручний fetch крихкий (анонімний `/exclusive` → NetworkError).
**Фікс:** тул `camofox_capture_response` — «поверни JSON першої XHR-відповіді, що метчить
URL-патерн, у межах таймауту». Надійніше й дешевше за ручний fetch у сторінковому контексті.
**Приорітет:** 🔴 (типовий патерн для data-екстракції; прибирає цілий клас помилок).

## #4 🔴 Контракт готовності для SPA (`waitFor`)
**Симптом:** `networkidle` на цих SPA часто НЕ настає; кожен викликач винаходить readiness наново.
**Доказ:** operating-knowledge harness-а прямо каже «готовність — за появою елемента, не networkidle»;
покладання на `newPageTimeoutMs:10000` + ручний поллінг.
**Код:** `navigate` / `create_tab`; `newPageTimeoutMs` у конфігу.
**Фікс:** `navigate`/`create_tab` приймають `waitFor: {selector|text|networkQuietMs}` з
fallback-таймаутом і повертають, коли умова виконана (а не просто по таймауту).
**Приорітет:** 🔴 (надійність навігації на всіх SPA).

## #5 🟡 Дефолтний віртуальний дисплей ≠ 1×1
**Симптом:** headless-прогін і watch-прогін (VNC) — РІЗНІ середовища; не можна чисто змішувати дані.
**Доказ:** дефолт Xvfb **1×1**; vnc-плагін перекриває на **1920×1080** (`vnc plugin: overriding
Xvfb resolution 1920x1080x24`). Отже viewport-залежний рендер/скріншоти відрізняються.
**Код:** `ctx.createVirtualDisplay` (vnc override у `/app/plugins/vnc/`); дефолт 1×1 у ядрі.
**Фікс:** дефолтний віртуальний дисплей — реальний розмір (напр. 1280×720), незалежно від VNC;
або окрема `display.resolution` у конфігу.
**Приорітет:** 🟡 (детермінізм/паритет headless↔watched; впливає на скріншоти).

## #6 🟡 REST `snapshot` без зображення
**Симптом:** через REST-шлях snapshot губиться візуал (скрін).
**Доказ:** REST snapshot НЕ повертає image; лише MCP-snapshot завжди тягне скрін.
**Код:** `/app/lib/openapi.js`, `/app/lib/plugins.js` (screenshot присутній, але не в REST-snapshot).
**Фікс:** опційний `?screenshot=true` (base64) на REST snapshot-ендпоінті.
**Приорітет:** 🟡 (форензика/скриптовий шлях).

## #7 🟡 Спостережуваність аргументів тулів
**Симптом:** дебаг агента наосліп — не видно, ЩО він виконав.
**Доказ:** логи показують `evaluate` + `resultType`, але НЕ сам `expression`; `navigate` URL логується,
`evaluate` args — ні. Годину дебагу з'їло саме це.
**Код:** логер запитів навколо `evaluate`.
**Фікс:** на debug-рівні логувати expression/args з redaction і лімітом довжини.
**Приорітет:** 🟡 (developer-experience при дебагу агентів).

## #8 🟢 Пул / keep-warm браузера
**Симптом:** кожна сесія — холодний старт ~10с; на матриці з десятків прогонів набігає.
**Доказ:** лог `browser pre-warmed ~9963ms` на кожну нову сесію.
**Фікс:** опційний пул теплих контекстів або persistent-режим повторного використання.
**Зв'язок:** прямо стосується `BotoFerma/docs/SPEC-camofox-pool-pattern-A.md`.
**Приорітет:** 🟢 (продуктивність під навантаженням; узгодити з pool-SPEC).

## Дрібне
- **trace.zip** осідає в `/root/.camofox/traces/<sessionKey>/` → губиться на `--rm` без volume.
  Обхід: `CAMOFOX_TRACES_DIR`. Фікс: дефолт на монтований шлях або warn при відсутності volume.

---

## Порядок
**#0 (fingerprint inject / #12)** — фундамент: без нього Profile-ідентичність нестабільна,
пул і SPEC-002 блокуються. Робити першим як окрему движкову зміну.
Далі ергономіка агента: **#2 evaluate-проєкція · #3 capture-XHR · #4 waitFor** — усі три
прямо б'ють по тому, що зробило агентні прогони повільними й крихкими. #1 (plugin-env) — за
приємність розробника.

## Не-camofox (для повноти, не фіксити тут)
- Провайдер МОДЕЛІ rate-limit-ить швидку серію викликів (не camofox; лікується пейсингом у harness).
- `hermes --cli` вішає oneshot без TTY (це Hermes CLI, не camofox).
