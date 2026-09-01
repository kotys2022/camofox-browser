# my-camofox-browser — контекст для фіксів

## Що це
Робоча копія/форк **camofox-browser** для внесення виправлень. Мета — полагодити ергономіку
й дефолти, що виявились слабким місцем при реальному використанні (див. `FIXES.md`).

> ✅ Вихідники **склоновані** з `github.com/jo-inc/camofox-browser` (upstream **v1.14.0**;
> JS-залежності встановлено `npm install --ignore-scripts` — бінарник браузера НЕ тягли,
> реальний запуск через Docker-образ `camofox-browser:local`). Бінарник за потреби:
> `npm run fetch-bin`.
> ⚠️ **Дрейф версій:** docs у `BotoFerma/docs` аналізували образ **v1.6.0**; код тепер
> **v1.14.0** — рядкові посилання звіряти з реальним деревом (для #0/#12 вже звірено).

## Звідки зауваження
Виявлено під час побудови **CryptoRank Extraction Harness** (`/srv/work/testCamofox`) —
дослідницький harness, що драйвить camofox через Hermes MCP-актора для екстракції vesting-даних
з cryptorank.io (replay HAR-fixtures, вимір skill-lift LLM на masked-даних). Тобто зауваження —
з живого агентного навантаження, не з рев'ю коду.

Пов'язано з **BotoFerma** (`/srv/work/BotoFerma/docs`) — платформа автоматизації, що вже
тримає camofox у пулі (`SPEC-camofox-pool-pattern-A.md`, `DECISION-session-liveness.md`,
`DECISION-state-persistence.md`). Фікс #8 (пул/keep-warm) прямо стосується того SPEC.

## Образ і як він працює (перевірено інспекцією `camofox-browser:local`)
- Образ **2.41GB**, node **v22**, HTTP-сервер камофокса слухає **9377** усередині контейнера.
- Стек: Node-сервер + **camoufox** (Firefox-форк) під **Xvfb** віртуальним дисплеєм; REST API + MCP.
- **Плагіни:** `/app/plugins/{persistence,vnc,youtube}` + монтований `cr-fixture` (з harness).
  Вантажаться ЛИШЕ ті, що є в `camofox.config.json` `plugins{}`.
- **Конфіг:** `/app/camofox.config.json` (монтується). Приклад робочого (replay+vnc):
  `plugins: {cr-fixture:{enabled}, persistence:{off}, youtube:{off}, vnc:{on|off}}`,
  `newPageTimeoutMs: 10000`, `interactive.mode: "off"`.
- **VNC (works):** `ENABLE_VNC=1` + `camofox.config.json` vnc.enabled → плагін перекриває
  Xvfb на **1920×1080**, піднімає x11vnc(:5900) + noVNC/websockify(:6080).
  Перегляд: `http://localhost:6080/vnc.html`. Логи: `vnc plugin enabled`, `vnc watcher started`.

## Як тестувати (патерн із harness)
```bash
docker run -d --rm --name cfx --shm-size=2g -p 127.0.0.1:9380:9377 \
  -v <cfg>.json:/app/camofox.config.json:ro \
  -v <fixture>:/fixtures:ro \
  -e CR_FIXTURE_MODE=replay -e CR_FIXTURE_HAR=/fixtures/page.har \
  -e CAMOFOX_CRASH_REPORT_ENABLED=false camofox-browser:local
# health: GET :9380/health → {"ok":true,...,"browserConnected","activeTabs"}
# tab:    POST :9380/tabs {userId,sessionKey,url}
# eval:   POST :9380/tabs/<tabId>/evaluate {userId,expression}
# kill:   DELETE :9380/sessions/<userId>
```
Прод-камофокс BotoFerma/harness тримає **:9377** — тестові контейнери гнати на **9378-9380**.
Cold browser start ≈ **10с** (`browser pre-warmed ~9963ms`) на КОЖНУ сесію.

## Ключові архітектурні факти (перевірені, для орієнтації)
- `config.js:81` — vnc mode allowlist `['off','desktop','novnc','auto']`.
- `config.js:145-146` — **pluginEnv хардкодиться лише на `ENABLE_VNC`** → `plugin.json→enableEnvVar`
  МЕРТВИЙ для всіх плагінів, крім vnc. Це корінь фікса #1.
- `config.js:182,186,187` — ENABLE_VNC / VNC_PORT / NOVNC_PORT.
- `/app/plugins/vnc/`: `index.js, spawn.js, vnc-launcher.js, vnc-watcher.sh, plugin.json(enableEnvVar:ENABLE_VNC)`.
- `/app/lib/openapi.js`, `/app/lib/plugins.js` — містять screenshot; **REST snapshot НЕ повертає image**
  (лише MCP-snapshot тягне скрін) — фікс #6.
- trace.zip осідає в `/root/.camofox/traces/<sessionKey>/` → губиться на `--rm` без volume
  (обхід: `CAMOFOX_TRACES_DIR`) — дрібний фікс.
- Логи `evaluate` містять `resultType`, але **НЕ сам expression** — фікс #7.
- Дефолтний віртуальний дисплей **1×1**; vnc перекриває на 1920×1080 → headless ≠ watched env — фікс #5.

## Середовище
NixOS, shell **fish** (без heredoc `<<`), python `/run/current-system/sw/bin/python3`, docker 29.5.2.

## Далі
Список змін із доказами, місцями в коді й пріоритетом — у **`FIXES.md`**. Топ-3 за впливом:
`evaluate`-проєкція (#2), «capture XHR» тул (#3), `waitFor`-контракт готовності (#4).
