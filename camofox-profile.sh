#!/usr/bin/env bash
# camofox-profile — інтерактивне меню керування профілями флоту (Варіант A).
#
# Тонка обгортка: збирає відповіді користувача → ГЕНЕРУЄ/ПРИБИРАЄ блок у
# profiles.toml (те саме, що робиться руками) → делегує validate/apply/health
# самому `proxyctl`. Bash НЕ парсить TOML для запису; читання значень для Edit —
# крихітним python `tomllib` (лише читання).
#
# Конфіг через env (зручно для локальної обкатки на temp-файлі):
#   FILE=/var/lib/camofox/profiles.toml   STATE_DIR=/var/lib/camofox
#   PROXYCTL=proxyctl                      SUDO=sudo   (SUDO= порожній → без sudo, для тесту)
#
# Cookies-крок поки лише "Пропустити" (VNC-capture — наступним кроком, після демо).
set -uo pipefail

FILE="${FILE:-/var/lib/camofox/profiles.toml}"
STATE_DIR="${STATE_DIR:-/var/lib/camofox}"
PROXYCTL="${PROXYCTL:-proxyctl}"
SUDO="${SUDO-sudo}"
IMAGE="${CAMOFOX_IMAGE:-camofox-browser-ai:local}"     # образ для VNC-capture контейнера
RUN_ENV_DIR="${CAMOFOX_RUN_ENV_DIR:-/run/camofox}"     # per-profile secret env-file (0600), пише proxyctl
BIND="${BIND:-127.0.0.1}"                              # loopback-публікація портів

# ── низькорівневі помічники (усе, що торкає 0600-файл — через $SUDO) ──────────
pc()         { $SUDO $PROXYCTL -f "$FILE" "$@"; }        # делегування proxyctl
read_file()  { $SUDO cat "$FILE"; }
write_file() {                                            # stdin → FILE (0600 root), атомарно
  local tmp; tmp="$(mktemp)"; cat > "$tmp"
  if [ -n "$SUDO" ]; then $SUDO install -m600 -o root -g root "$tmp" "$FILE"
  else install -m600 "$tmp" "$FILE"; fi
  rm -f "$tmp"
}
append_block() { { read_file; printf '%s' "$1"; } | write_file; }

confirm()   { local a; read -rp "${1:-Continue?} [y/N] " a; [[ "$a" =~ ^[Yy]$ ]]; }
list_ids()  { read_file | grep -oE '^\[profiles\.[^]]+\]' | sed -E 's/\[profiles\.(.+)\]/\1/'; }
has_login() { $SUDO bash -c "ls '$STATE_DIR/$1'/profiles/*/storage-state.json" >/dev/null 2>&1; }  # чи є захоплений логін у volume
next_port() { local mx; mx="$(read_file | grep -oE '^[[:space:]]*port[[:space:]]*=[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | sort -n | tail -1)"; echo "$(( ${mx:-9400} + 1 ))"; }

read_profile() {   # id → "kind|country|port|proxy"  (префіл для Edit; лише читання)
  read_file | python3 -c 'import tomllib,sys
p=tomllib.load(sys.stdin.buffer).get("profiles",{}).get(sys.argv[1],{})
print(p.get("kind",""),p.get("country",""),p.get("port",""),p.get("proxy",""),sep="|")' "$1"
}

port_owner() {     # port [exclude_id] → друкує id профілю, що займає цей порт (крім exclude)
  read_file | python3 -c 'import tomllib,sys
d=tomllib.load(sys.stdin.buffer).get("profiles",{})
port=sys.argv[1]; excl=sys.argv[2] if len(sys.argv)>2 else ""
for k,v in d.items():
    if str(v.get("port",""))==port and k!=excl: print(k); break' "$1" "${2:-}"
}

host_owner() {     # port → "container:<name>" якщо публікує docker-контейнер;
                   # "host-process" якщо слухає хост; інакше порожньо
  local c
  c="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | awk -v p=":$1->" 'index($0,p){print $1; exit}')"
  [ -n "$c" ] && { echo "container:$c"; return; }
  command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$1" 2>/dev/null | grep -q . && echo "host-process"
}

ask_port() {       # default [exclude_id] → ставить глобальну PORT з reprompt при колізії
  local def="$1" excl="${2:-}" p ow ho
  while true; do
    read -rp "порт [$def]: " p; PORT="${p:-$def}"
    if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then echo "  ! порт має бути числом"; continue; fi
    ow="$(port_owner "$PORT" "$excl")"
    if [ -n "$ow" ]; then echo "  ! порт $PORT уже в profiles.toml (профіль '$ow') — введи інший"; continue; fi
    # host-рівень: чужий контейнер/процес зайняв порт (власний контейнер цього профілю — не рахуємо)
    ho="$(host_owner "$PORT")"
    if [ -n "$ho" ] && [ "$ho" != "container:camofox-$excl" ]; then
      echo "  ! порт $PORT зайнятий на хості ($ho) — docker не зможе прив'язати; введи інший"; continue
    fi
    break
  done
}

# ── генерація блоку (= те, що ти пишеш руками) ───────────────────────────────
gen_block() {      # id kind cc port proxy proxies_file locale
  local id="$1" kind="$2" cc="$3" port="$4" proxy="$5" pf="$6" loc="$7"
  printf '\n[profiles.%s]\n' "$id"
  printf 'kind    = "%s"\n' "$kind"
  [ -n "$cc" ] && printf 'country = "%s"\n' "$cc"
  printf 'port    = %s\n' "$port"
  if [ "$kind" = sticky ] && [ -n "$proxy" ]; then printf 'proxy   = "%s"\n' "$proxy"; fi
  if [ "$kind" = pool ] && [ -n "$pf" ]; then
    printf 'proxies = [\n'
    while IFS= read -r l; do l="${l%%#*}"; l="$(echo "$l" | xargs)"; [ -n "$l" ] && printf '  "%s",\n' "$l"; done < "$pf"
    printf ']\n'
  fi
  [ "$loc" = yes ] && printf 'localeFollowsProxy = true\n'
}

remove_block() {   # id → друкує вміст FILE без цього блоку (до наступного [section]/EOF)
  read_file | awk -v s="[profiles.$1]" '
    $0==s {skip=1; next}
    skip && /^\[/ {skip=0}
    !skip {print}'
}

# ── діалоги ──────────────────────────────────────────────────────────────────
ask_proxy() {      # → глобальні KIND CC PROXY PF LOCALE
  KIND=sticky; CC=""; PROXY=""; PF=""; LOCALE=no
  local m
  while true; do
    echo "  Проксі: 1) без проксі (direct)   2) один проксі   3) пул (одна країна)"
    read -rp "  вибір [1] (або встав proxy URL): " m; m="${m:-1}"
    case "$m" in
      1) KIND=sticky; break;;
      2) KIND=sticky; read -rp "  proxy URL (scheme://user:pass@host:port): " PROXY   # TODO: secret-hygiene (deferred)
         read -rp "  country (напр. DE; порожньо = за geoip з exit-IP): " CC; break;;
      3) KIND=pool;   read -rp "  файл зі списком проксі (URL на рядок, # коментарі): " PF
         read -rp "  country (обов'язково для пулу): " CC; break;;
      *://*) KIND=sticky; PROXY="$m"; echo "  (прийнято як single-proxy)"
         read -rp "  country (напр. DE; порожньо = за geoip з exit-IP): " CC; break;;
      *) echo "  ! обери 1, 2 або 3 (URL можна вставити прямо тут)";;
    esac
  done
  if [ -n "$PROXY$PF" ] && [ -n "$CC" ]; then
    local a; read -rp "  [advanced] localeFollowsProxy? (детермін. пін мови; у межах однієї країни зазвичай зайве) [y/N] " a
    [[ "$a" =~ ^[Yy]$ ]] && LOCALE=yes
  fi
}

maybe_capture() {  # id → ПІСЛЯ apply пропонує візуальний логін (VNC) для куки
  confirm "Захопити куки (візуальний логін через VNC) для '$1' зараз?" && do_capture "$1"
}

commit_apply() {   # $1 = шлях до файлу з НОВИМ повним вмістом profiles.toml.
  # Валідуємо той файл; реальний profiles.toml пишемо ЛИШЕ якщо валідний (файл ніколи
  # не лишається битим). ВАЖЛИВО: приймаємо ФАЙЛ, а не stdin — інакше `read` у confirm
  # читав би з pipe, а не з термінала (промпт «Застосувати?» відповідав би сам N).
  local src="$1"
  echo "== validate =="
  if ! $SUDO $PROXYCTL -f "$src" validate; then
    echo "!! validate впав — profiles.toml НЕ змінено"; return 1
  fi
  echo "== план (що зробить apply) =="; $SUDO $PROXYCTL -f "$src" apply   # dry-run ПРОТИ нового вмісту
  confirm "Створити/оновити й застосувати?" || { echo "скасовано — profiles.toml НЕ змінено"; return 2; }
  if [ -n "$SUDO" ]; then $SUDO install -m600 -o root -g root "$src" "$FILE"
  else install -m600 "$src" "$FILE"; fi
  $SUDO $PROXYCTL -f "$FILE" apply --apply; return 0
}

do_create() {
  local id; read -rp "id профілю: " id; [ -z "$id" ] && { echo "порожній id"; return; }
  list_ids | grep -qx "$id" && { echo "профіль '$id' уже існує (візьми Edit)"; return; }
  ask_port "$(next_port)"
  ask_proxy
  local blk; blk="$(gen_block "$id" "$KIND" "$CC" "$PORT" "$PROXY" "$PF" "$LOCALE")"
  echo "---- блок ----"; printf '%s\n' "$blk"; echo "--------------"
  local tmp; tmp="$(mktemp)"; { read_file; printf '%s' "$blk"; } > "$tmp"
  commit_apply "$tmp" && maybe_capture "$id"   # один confirm усередині; після apply — опц. VNC-логін
  rm -f "$tmp"
}

do_edit() {
  echo "профілі:"; list_ids | sed 's/^/  /'
  local id; read -rp "який редагувати: " id
  list_ids | grep -qx "$id" || { echo "нема такого"; return; }
  local ckind ccc cport cproxy; IFS='|' read -r ckind ccc cport cproxy <<<"$(read_profile "$id")"
  echo "поточне: kind=$ckind country=${ccc:-–} port=$cport proxy=${cproxy:+<set>}"
  ask_port "$cport" "$id"
  ask_proxy
  local blk; blk="$(gen_block "$id" "$KIND" "$CC" "$PORT" "$PROXY" "$PF" "$LOCALE")"
  echo "---- новий блок (профіль перегенеровується) ----"; printf '%s\n' "$blk"; echo "-----------------------------------------------"
  local tmp; tmp="$(mktemp)"; { remove_block "$id"; printf '%s' "$blk"; } > "$tmp"
  commit_apply "$tmp" && maybe_capture "$id"   # один confirm усередині; після apply — опц. VNC-логін
  rm -f "$tmp"
}

do_delete() {
  echo "профілі:"; list_ids | sed 's/^/  /'
  local id; read -rp "який видалити: " id
  list_ids | grep -qx "$id" || { echo "нема такого"; return; }
  confirm "Прибрати профіль '$id' з файлу?" || return
  remove_block "$id" | write_file
  echo "== prune (прибрати контейнер, якого нема в toml) =="; pc apply --apply --prune
  if confirm "Стерти й ДАНІ профілю ($STATE_DIR/$id: identity+куки, НЕЗВОРОТНЬО)?"; then
    $SUDO rm -rf "${STATE_DIR:?}/$id" && echo "дані стерто"
  else echo "дані лишено у $STATE_DIR/$id"; fi
}

# ── VNC-capture: візуальний логін → storage_state у volume ───────────────────
profile_inline_env() {   # id → "-e K=V …" (той самий base_env, що й у proxyctl)
  read_file | python3 -c 'import tomllib,sys
p=tomllib.load(sys.stdin.buffer).get("profiles",{}).get(sys.argv[1],{})
e={"ENABLE_IDENTITY":"1","CAMOFOX_CRASH_REPORT_ENABLED":"false","MAX_OLD_SPACE_SIZE":"2048"}
if p.get("country"): e["PROXY_COUNTRY"]=p["country"]
if p.get("localeFollowsProxy"): e["CAMOFOX_LOCALE_FOLLOWS_PROXY"]="1"
for k,v in (p.get("env") or {}).items(): e[str(k)]=str(v)
print(" ".join("-e %s=%s"%(k,v) for k,v in e.items()))' "$1"
}

do_capture() {     # [id] — з Create/Edit передається; без арг → інтерактивний вибір (re-login)
  local id="${1:-}"
  if [ -z "$id" ]; then echo "профілі:"; list_ids | sed 's/^/  /'; read -rp "профіль для (пере)захоплення куки: " id; fi
  list_ids | grep -qx "$id" || { echo "нема такого профілю"; return; }
  local uid="$id"   # userId сесії = id профілю (майбутні сесії з цим userId відновлять логін)
  local url; read -rp "URL логіну (напр. https://accounts.google.com): " url
  [ -z "$url" ] && { echo "порожній URL"; return; }
  local cport; cport="$(read_profile "$id" | cut -d'|' -f3)"; [ -z "$cport" ] && { echo "нема порту"; return; }
  # вільні хост-порти (--network host → біндяться напряму на хост, loopback-only)
  local nv=6080; while [ -n "$(host_owner "$nv")" ]; do nv=$((nv+1)); done
  local vp=5900; while [ -n "$(host_owner "$vp")" ]; do vp=$((vp+1)); done
  echo "УВАГА: тимчасово ЗУПИНИТЬ контейнер '$id' (спільний volume); capture-контейнер"
  echo "       іде з --network host; noVNC — лише loopback (127.0.0.1), без пароля."
  confirm "Продовжити?" || return

  local vname="camofox-$id-vnc" inline efarg="" envfile="$RUN_ENV_DIR/$id.env"
  local key; key="$(openssl rand -hex 16 2>/dev/null || echo "cfxcap$$")"   # ephemeral, лише для storage_state export
  inline="$(profile_inline_env "$id")"
  $SUDO test -e "$envfile" && efarg="--env-file $envfile"

  echo ">>> зупиняю camofox-$id"; $SUDO docker stop "camofox-$id" >/dev/null 2>&1 || true
  echo ">>> піднімаю $vname (--network host; REST :$cport, noVNC :$nv, x11vnc :$vp)"
  # --network host: інакше docker-publish приходить не як loopback → noVNC недосяжний
  # (websockify біндить loopback) і storage_state дає 403. shellcheck disable=SC2086
  $SUDO docker run -d --rm --name "$vname" --shm-size=2g --network host \
    -v "$STATE_DIR/$id:/root/.camofox" \
    -e CAMOFOX_PORT="$cport" -e NOVNC_PORT="$nv" -e VNC_PORT="$vp" -e CAMOFOX_API_KEY="$key" \
    -e BROWSER_IDLE_TIMEOUT_MS=0 \
    $efarg $inline -e ENABLE_VNC=1 \
    "$IMAGE" >/dev/null || { echo "!! docker run впав"; return 1; }

  echo ">>> чекаю рушій"; curl -s --retry 60 --retry-delay 1 --retry-connrefused --max-time 120 "http://$BIND:$cport/health" >/dev/null || echo "(health не відповів — перевір docker logs $vname)"

  # Відкриваємо вкладку з РЕТРАЄМ: перший launch через проксі тягне GeoIP ~65МБ і
  # може дати timeout/гонку Xvfb. Повторюємо, поки не отримаємо tabId (це і піднімає
  # браузер). Без цього вкладка губилась → порожній (чорний) noVNC-екран.
  echo ">>> відкриваю вкладку (userId=$uid) на $url (перший launch може зайняти час)…"
  local i resp tabok=0
  for i in $(seq 1 10); do
    resp="$(curl -s --max-time 80 -X POST "http://$BIND:$cport/tabs" -H 'content-type: application/json' \
      -d "{\"userId\":\"$uid\",\"sessionKey\":\"vnc\",\"url\":\"$url\"}" 2>/dev/null || true)"
    printf '%s' "$resp" | grep -q '"tabId"' && { tabok=1; break; }
    printf '\r    …спроба %s (браузер піднімається)   ' "$i"; sleep 2
  done
  [ "$tabok" = 1 ] && echo "    ✓ вкладку відкрито" || echo "    ! вкладка не відкрилась — глянь: docker logs $vname"

  # Чекаємо, поки x11vnc приатачиться до дисплея браузера (running:true).
  echo ">>> чекаю, поки Camoufox намалюється (x11vnc attach)…"
  local st ready=0 disp
  for i in $(seq 1 60); do
    st="$(curl -s --max-time 3 "http://$BIND:$cport/vnc/status" 2>/dev/null || true)"
    if printf '%s' "$st" | grep -q '"running":true'; then
      disp="$(printf '%s' "$st" | grep -oE '"display":"[^"]*"' | cut -d'"' -f4)"
      printf '\r    ✓ Camoufox піднявся, x11vnc приатачений (display %s)            \n' "${disp:-?}"
      ready=1; break
    fi
    printf '\r    …%ss vnc:attaching   ' "$i"; sleep 1
  done
  [ "$ready" = 1 ] || printf '\r    ! x11vnc не приатачився за 60с — глянь: docker logs %s        \n' "$vname"

  echo; echo "  ── Відкрий у браузері:  http://$BIND:$nv/vnc.html"
  echo "  ── Залогінься на сайті (MFA/CAPTCHA — вручну)."
  read -rp "  Коли завершив — Enter, щоб зберегти стан… " _

  echo ">>> експортую storage_state (persistence запише у volume)"
  local tmpout; tmpout="$(mktemp)"
  curl -s "http://$BIND:$cport/sessions/$uid/storage_state" -H "Authorization: Bearer $key" -o "$tmpout"
  local nc; nc="$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1])).get("cookies",[])))' "$tmpout" 2>/dev/null || echo '?')"
  echo ">>> захоплено $nc куків."
  rm -f "$tmpout"

  echo ">>> прибираю $vname"; $SUDO docker rm -f "$vname" >/dev/null 2>&1 || true
  # rm -f перед apply: proxyctl бачить зупинений контейнер як "keep" і не перезапускає,
  # тому примусово знімаємо його — apply підніме свіжий на тому ж volume.
  echo ">>> відновлюю нормальний контейнер"; $SUDO docker rm -f "camofox-$id" >/dev/null 2>&1 || true; pc apply --apply
  echo ">>> Готово. Майбутні сесії з userId='$uid' відновлять цей логін (persistence у $STATE_DIR/$id)."
}

do_list() {        # proxyctl ls (live status) + logged-in позначка з volume
  pc ls
  echo "  logged-in (є збережений storage-state):"
  local any=0 id
  while IFS= read -r id; do
    has_login "$id" && { echo "    ✓ $id"; any=1; }
  done < <(list_ids)
  [ "$any" = 0 ] && echo "    (жодного)"
}

menu() {
  while true; do
    echo; echo "=== camofox-profile ($FILE) ==="
    echo " 1) List   2) Create   3) Edit   4) Delete   5) Health   q) Quit"
    local x; read -rp "> " x
    case "$x" in
      1) do_list;; 2) do_create;; 3) do_edit;; 4) do_delete;; 5) pc health;;
      q|Q) break;; *) echo "?";;
    esac
  done
}

# Запускати меню лише при прямому виклику; при `source` — доступні функції (для тестів).
[ "${BASH_SOURCE[0]}" = "${0}" ] && menu
