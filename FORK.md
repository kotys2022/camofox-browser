# Форк camofox-browser

Це **форк** [`jo-inc/camofox-browser`](https://github.com/jo-inc/camofox-browser),
база — **v1.14.0**. Мета форку — полагодити ергономіку й дефолти, що виявились
слабким місцем під реальним агентним навантаженням (data-екстракція через MCP).

Кожна зміна: чиста логіка в `lib/*` з unit-тестами → вбудова в `server.js`/MCP →
регенерація `openapi.json` → живий E2E у Docker. Повний набір тестів проходить у
CI-паритетному образі (`Dockerfile.test`): **75 suites / 912 тестів, 0 failed**.
Деталі кожної зміни з доказами — у `FIXES.md`.

## Зміни (за областями)

### Ідентичність / anti-detection (плагін `identity`, новий)
- **Персист + інжект fingerprint** при КОЖНОМУ launch через новий мутуючий пре-хук
  ядра `browser:launchOptions` — профіль лишається стабільним після idle-kill /
  crash / рестарту контейнера (раніше щолаунч генерувався новий fingerprint).
- **WebGL-пін** (`vendor/renderer` через `webgl_config`) — не дрейфує між relaunch.
- **Canvas-пін** (`canvas:aaOffset`) пост-резолюшн через `browser:launching`
  (rewrite `CAMOU_CONFIG_*` env-чанків) — camoufox інакше ре-рандомить його щолаунч.
- **Seed-фільтр за схемою білда** — інжектимо лише seeds, що є в `properties.json`
  (старі білди не мають `audio:seed`/`canvas:seed` і кидали `UnknownProperty`).
- **Гео-когерентний locale** — `navigator.language` генерується під країну проксі
  (`PROXY_COUNTRY` через вбудований ICU), коли проксі активний. timezone/geo/webrtc
  і так деривуються з exit-IP через geoip.
- Активація: `plugins.identity` у конфізі або `ENABLE_IDENTITY=1`;
  шлях — `CAMOFOX_FINGERPRINT_FILE` (дефолт `<profileDir>/identity.json`).

### MCP-тули та REST
- **Новий тул `camofox_capture_response`** (REST `POST /tabs/:id/capture`) —
  захоплює першу XHR/fetch-відповідь за URL-патерном (підрядок або `/regex/`),
  повертає body (JSON коли можливо). Надійніше за ручний `fetch()` у `evaluate`.
- **`camofox_evaluate` + проєкція/ліміт** — опційні `projection` (jq-подібний шлях)
  і `maxBytes` (обрізка з маркером), щоб великі блоби не заливали контекст агента.
- **`waitFor`-контракт готовності** на `camofox_navigate` / `camofox_create_tab` —
  `{selector|text|networkQuietMs}` з fallback-таймаутом; повертає `{matched,waitedMs}`.
  Надійніше за `networkidle`, який на багатьох SPA не настає.
- **`?screenshot=true`** — аліас до `includeScreenshot` на обох snapshot-endpoints.

### Плагіни / конфіг / спостережуваність
- **Уніфікований env-gate плагінів** — `ENABLE_<PLUGIN>=1` вмикає будь-який плагін
  (раніше env-активація працювала лише для VNC).
- **Keep-warm браузера** — `BROWSER_IDLE_TIMEOUT_MS=0` тримає браузер теплим (не
  idle-закриває) + eager re-warm після несподіваного disconnect. Прибирає ~10с
  cold-start на розріджених прогонах.
- **Конфігурована роздільність дисплея** — `CAMOFOX_DISPLAY_RESOLUTION` (дефолт
  `1280x720`), щоб вирівняти headless із watched (VNC) для паритету скріншотів.
- **Лог `evaluate` expression** — `CAMOFOX_LOG_TOOL_ARGS=1` логує вираз із
  redaction секретів і лімітом довжини (за замовчуванням вимкнено).
- **Warn про ефемерні traces** — попередження, якщо трейсинг пише в дефолтний
  шлях без `CAMOFOX_TRACES_DIR` (trace.zip губиться на `--rm`).

### Інструменти
- **`scripts/profile-bundle.mjs`** — export/import профілю (fingerprint + куки) як
  tar, з ре-кеїнгом `userId` і попередженнями про гео-когерентність та IndexedDB.
- **`scripts/verify-identity-e2e.sh`** — живий E2E стабільності ідентичності
  (rebuild образу + idle-kill relaunch, POSITIVE/NEGATIVE-контроль).
- **`Dockerfile.test`** — CI-паритетний тест-раннер (повні залежності + бінарник
  camoufox + xvfb) для запуску сьютів, що потребують реального браузера.

## Нові прапорці середовища

| Env | Дефолт | Що |
|---|---|---|
| `ENABLE_IDENTITY` / `ENABLE_<PLUGIN>` | — | env-активація плагіна |
| `CAMOFOX_FINGERPRINT_FILE` | `<profileDir>/identity.json` | шлях до identity.json |
| `BROWSER_IDLE_TIMEOUT_MS=0` | `300000` | keep-warm (не idle-закривати) |
| `CAMOFOX_DISPLAY_RESOLUTION` | `1280x720x24` | роздільність Xvfb |
| `CAMOFOX_EVALUATE_MAX_RESULT_BYTES` | `0` (без ліміту) | дефолт-cap результату evaluate |
| `CAMOFOX_LOG_TOOL_ARGS` | off | лог evaluate expression (redacted) |
| `PROXY_URL` | — | проксі одним рядком `scheme://user:pass@host:port`; discrete `PROXY_*` перекривають |
| `CAMOFOX_LOCALE_FOLLOWS_PROXY` | off | re-home `navigator.language` персистованого профілю під `PROXY_COUNTRY` щолаунч (лише локаль, решта відбитка стабільна) |
| `PROXY_URLS` | — | пул різних проксі (розділювач новий рядок/кома); мода `list`, ротація per-session |
| `CAMOFOX_PROXY_LIST_FILE` | — | файл-список проксі (URL на рядок, `#`-коментарі); те саме, що `PROXY_URLS` |

Апстрім-код не чіпався там, де можна було зробити зміну плагіном або хуком; ядро
правилось мінімально (новий пре-хук `browser:launchOptions`, кілька опційних
параметрів). Дефолтна поведінка сумісна — усі нові можливості opt-in.
