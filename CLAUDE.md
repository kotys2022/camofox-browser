# my-camofox-browser — нотатки розробника

## Що це
Форк **[jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser)** (upstream **v1.14.0**)
з набором виправлень ергономіки й дефолтів під реальне агентне навантаження
(data-екстракція через MCP). Огляд змін форку — розділ **Fork changes** у `README.md`.

> JS-залежності: `npm install --ignore-scripts` (бінарник браузера не тягнеться; за потреби
> `npm run fetch-bin`). Реальний запуск — через Docker-образ (`make build` → `camofox-browser-ai:local`).

## Образ і як він працює
- node **v22**, HTTP-сервер camoufox слухає **9377** усередині контейнера.
- Стек: Node-сервер + **camoufox** (Firefox-форк) під **Xvfb** віртуальним дисплеєм; REST API + MCP.
- **Плагіни:** `plugins/{identity,persistence,vnc,youtube}`. Вантажаться ті, що є в
  `camofox.config.json` `plugins{}`, АБО ввімкнені env-змінною `ENABLE_<PLUGIN>=1` (див. #1).
- **VNC:** `ENABLE_VNC=1` + `vnc.enabled` → плагін перекриває Xvfb на **1920×1080**, піднімає
  x11vnc(:5900) + noVNC/websockify(:6080). Перегляд: `http://localhost:6080/vnc.html`.

## Як тестувати
CI-паритетний прогін усіх сьютів (потребує реального бінарника) — через `Dockerfile.test`:
```bash
docker build -f Dockerfile.test -t camofox-browser-ai:test .
docker run --rm --shm-size=2g camofox-browser-ai:test tests/unit
```
Швидкий ручний драйв движка:
```bash
docker run -d --rm --name cfx --shm-size=2g -p 127.0.0.1:9378:9377 \
  -e CAMOFOX_CRASH_REPORT_ENABLED=false camofox-browser-ai:local
# health: GET :9378/health → {"ok":true,...,"browserConnected","activeTabs"}
# tab:    POST :9378/tabs {userId,sessionKey,url}
# eval:   POST :9378/tabs/<tabId>/evaluate {userId,expression}
# kill:   DELETE :9378/sessions/<userId>
```
Cold browser start ≈ **10с** (`browser pre-warmed`). Unit-сьюти, що спавнять сервер, потребують
бінарника → зелені лише в контейнері (`Dockerfile.test`).

## Ключові архітектурні факти
- `browser` — **singleton на контейнер** → один fingerprint на весь контейнер (сесії =
  `newContext` per userId). Для N паралельних профілів → N контейнерів.
- Хук ядра **`browser:launchOptions`** (пре-резолюшн) — seam для інжекту `fingerprint`/`config`/
  `webgl_config`; `browser:launching` (пост-резолюшн) — для правки вже-серіалізованих
  `CAMOU_CONFIG_*` env-чанків (напр. canvas-pin). Обидва — мутуючі, за посиланням.
- `geoip=true` (коли є проксі) деривує timezone/locale/geolocation/webrtc з exit-IP проксі
  щолаунч. `navigator.language` — з fingerprint (фіксований), тому генерується під `PROXY_COUNTRY`.
- `pluginEnv = process.env` (#1) → `ENABLE_<PLUGIN>=1` вмикає будь-який плагін.
- Persist: `identity.json` (fingerprint) + `storage-state.json` (куки) у `profileDir`
  (`~/.camofox/profiles`, ключ кук — `sha256(userId)`).

## Нові env-прапорці форку
`ENABLE_IDENTITY`, `CAMOFOX_FINGERPRINT_FILE`, `BROWSER_IDLE_TIMEOUT_MS=0` (keep-warm),
`CAMOFOX_DISPLAY_RESOLUTION`, `CAMOFOX_EVALUATE_MAX_RESULT_BYTES`, `CAMOFOX_LOG_TOOL_ARGS`,
`CAMOFOX_TRACES_DIR`. Деталі — розділи **Fork changes** / **Environment Variables** у `README.md`.

## Середовище розробки
Тести — native ESM (`NODE_OPTIONS=--experimental-vm-modules`), `jest.config.cjs` `transform:{}`.
Запуск jest — з кореня репо.
