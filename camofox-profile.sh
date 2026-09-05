#!/usr/bin/env bash
# camofox-profile — інтерактивне меню керування профілями флоту (двомовне EN/UA).
#
# Тонка обгортка: збирає відповіді користувача → ГЕНЕРУЄ/ПРИБИРАЄ блок у
# profiles.toml → делегує validate/apply/health самому `proxyctl`. Bash НЕ парсить
# TOML для запису; читання значень для Edit — крихітним python `tomllib`.
#
# Мова: вибір на старті, або CAMOFOX_PROFILE_LANG=en|ua (пропускає запит).
# Конфіг через env: FILE, STATE_DIR, PROXYCTL, SUDO (порожній → без sudo, для тесту).
set -uo pipefail

FILE="${FILE:-/var/lib/camofox/profiles.toml}"
STATE_DIR="${STATE_DIR:-/var/lib/camofox}"
PROXYCTL="${PROXYCTL:-proxyctl}"
SUDO="${SUDO-sudo}"
IMAGE="${CAMOFOX_IMAGE:-camofox-browser-ai:local}"     # образ для VNC-capture контейнера
RUN_ENV_DIR="${CAMOFOX_RUN_ENV_DIR:-/run/camofox}"     # per-profile secret env-file (0600)
BIND="${BIND:-127.0.0.1}"                              # loopback-публікація портів

# ── i18n: усі user-facing рядки (printf-шаблони; %s = аргумент) ───────────────
declare -A M
set_lang() {
  case "$1" in
    ua)
      M[menu_line]=' 1) Список   2) Створити   3) Редагувати   4) Видалити   5) Здоров’я   q) Вихід'
      M[unknown]='?'
      M[profiles]='профілі:'
      M[no_such]='нема такого профілю'
      M[ask_id]='id профілю: '
      M[empty_id]='порожній id'
      M[exists]="профіль '%s' уже існує (візьми Edit)"
      M[which_edit]='який редагувати: '
      M[which_delete]='який видалити: '
      M[current]='поточне: kind=%s country=%s port=%s proxy=%s'
      M[edit_what_menu]='  що редагувати: 1) мережа (проксі/порт)   2) куки (VNC-логін)'
      M[edit_what_choice]='  вибір [1]: '
      M[block_hdr]='---- блок ----'
      M[block_sep]='--------------'
      M[newblock_hdr]='---- новий блок (профіль перегенеровується) ----'
      M[newblock_sep]='-----------------------------------------------'
      M[port_prompt]='порт [%s]: '
      M[port_num]='  ! порт має бути числом'
      M[port_intoml]="  ! порт %s уже в profiles.toml (профіль '%s') — введи інший"
      M[port_host]='  ! порт %s зайнятий на хості (%s) — docker не зможе прив’язати; введи інший'
      M[port_kick]='  ! %s — осиротілий VNC-контейнер цього скрипта. Прибрати й звільнити порт?'
      M[proxy_menu]='  Проксі: 1) без проксі (direct)   2) один проксі   3) пул (одна країна)'
      M[proxy_choice]='  вибір [1] (або встав proxy URL): '
      M[proxy_url]='  proxy URL (scheme://user:pass@host:port): '
      M[country_opt]='  country (напр. DE; порожньо = за geoip з exit-IP): '
      M[pool_file]='  файл зі списком проксі (URL на рядок, # коментарі): '
      M[country_req]='  country (обов’язково для пулу): '
      M[proxy_accepted]='  (прийнято як single-proxy)'
      M[proxy_bad]='  ! обери 1, 2 або 3 (URL можна вставити прямо тут)'
      M[locale_q]='  [advanced] localeFollowsProxy? (детермін. пін мови; у межах однієї країни зазвичай зайве)'
      M[val_fail]='!! validate впав — profiles.toml НЕ змінено'
      M[plan_hdr]='== план (що зробить apply) =='
      M[confirm_apply]='Створити/оновити й застосувати?'
      M[cancelled]='скасовано — profiles.toml НЕ змінено'
      M[cap_offer]="Захопити куки (візуальний логін через VNC) для '%s' зараз?"
      M[del_confirm]="Прибрати профіль '%s' з файлу?"
      M[prune_hdr]='== prune (прибрати контейнер, якого нема в toml) =='
      M[del_data]='Стерти й ДАНІ профілю (%s: identity+куки, НЕЗВОРОТНЬО)?'
      M[data_deleted]='дані стерто'
      M[data_kept]='дані лишено у %s'
      M[which_capture]='профіль для (пере)захоплення куки: '
      M[login_url]='URL логіну (напр. https://accounts.google.com): '
      M[empty_url]='порожній URL'
      M[no_port]='нема порту'
      M[cap_warn1]="УВАГА: тимчасово ЗУПИНИТЬ контейнер '%s' (спільний volume); capture-контейнер"
      M[cap_warn2]='       іде з --network host; noVNC — лише loopback (127.0.0.1), без пароля.'
      M[cap_continue]='Продовжити?'
      M[cap_stop]='>>> зупиняю camofox-%s'
      M[cap_start]='>>> піднімаю %s (--network host; REST :%s, noVNC :%s, x11vnc :%s)'
      M[cap_runfail]='!! docker run впав'
      M[cap_wait_engine]='>>> чекаю рушій'
      M[cap_health_no]='(health не відповів — перевір docker logs %s)'
      M[cap_opentab]='>>> відкриваю вкладку (userId=%s) на %s (перший launch може зайняти час)…'
      M[cap_try]='    …спроба %s (браузер піднімається)   '
      M[cap_tabok]='    ✓ вкладку відкрито'
      M[cap_tabfail]='    ! вкладка не відкрилась — глянь: docker logs %s'
      M[cap_wait_draw]='>>> чекаю, поки Camoufox намалюється (x11vnc attach)…'
      M[cap_up]='    ✓ Camoufox піднявся, x11vnc приатачений (display %s)            '
      M[cap_attaching]='    …%ss vnc:attaching   '
      M[cap_noattach]='    ! x11vnc не приатачився за 60с — глянь: docker logs %s        '
      M[cap_open_url]='  ── Відкрий у браузері:  http://%s:%s/vnc.html'
      M[cap_login_here]='  ── Залогінься на сайті (MFA/CAPTCHA — вручну).'
      M[cap_enter]='  Коли завершив — Enter, щоб зберегти стан… '
      M[cap_export]='>>> експортую storage_state (persistence запише у volume)'
      M[cap_captured]='>>> захоплено %s куків.'
      M[cap_cleanup]='>>> прибираю %s'
      M[cap_restore]='>>> відновлюю нормальний контейнер'
      M[cap_done]=">>> Готово. Майбутні сесії з userId='%s' відновлять цей логін (persistence у %s)."
      M[loggedin_hdr]='  logged-in (є збережений storage-state):'
      M[loggedin_none]='    (жодного)'
      M[yn]=' [т/Н] '
      ;;
    *)  # en (default)
      M[menu_line]=' 1) List   2) Create   3) Edit   4) Delete   5) Health   q) Quit'
      M[unknown]='?'
      M[profiles]='profiles:'
      M[no_such]='no such profile'
      M[ask_id]='profile id: '
      M[empty_id]='empty id'
      M[exists]="profile '%s' already exists (use Edit)"
      M[which_edit]='which to edit: '
      M[which_delete]='which to delete: '
      M[current]='current: kind=%s country=%s port=%s proxy=%s'
      M[edit_what_menu]='  what to edit: 1) network (proxy/port)   2) cookies (VNC login)'
      M[edit_what_choice]='  choice [1]: '
      M[block_hdr]='---- block ----'
      M[block_sep]='--------------'
      M[newblock_hdr]='---- new block (profile regenerated) ----'
      M[newblock_sep]='----------------------------------------'
      M[port_prompt]='port [%s]: '
      M[port_num]='  ! port must be a number'
      M[port_intoml]="  ! port %s already in profiles.toml (profile '%s') — pick another"
      M[port_host]='  ! port %s is taken on the host (%s) — docker cannot bind; pick another'
      M[port_kick]='  ! %s is an orphaned VNC container from this script. Remove it and free the port?'
      M[proxy_menu]='  Proxy: 1) none (direct)   2) single proxy   3) pool (one country)'
      M[proxy_choice]='  choice [1] (or paste a proxy URL): '
      M[proxy_url]='  proxy URL (scheme://user:pass@host:port): '
      M[country_opt]='  country (e.g. DE; empty = geoip from exit-IP): '
      M[pool_file]='  file with the proxy list (one URL per line, # comments): '
      M[country_req]='  country (required for a pool): '
      M[proxy_accepted]='  (accepted as single-proxy)'
      M[proxy_bad]='  ! choose 1, 2 or 3 (a URL can be pasted here directly)'
      M[locale_q]='  [advanced] localeFollowsProxy? (deterministic language pin; usually redundant within one country)'
      M[val_fail]='!! validate failed — profiles.toml NOT changed'
      M[plan_hdr]='== plan (what apply will do) =='
      M[confirm_apply]='Create/update and apply?'
      M[cancelled]='cancelled — profiles.toml NOT changed'
      M[cap_offer]="Capture cookies (visual VNC login) for '%s' now?"
      M[del_confirm]="Remove profile '%s' from the file?"
      M[prune_hdr]='== prune (remove a container not in the toml) =='
      M[del_data]='Also delete profile DATA (%s: identity+cookies, IRREVERSIBLE)?'
      M[data_deleted]='data deleted'
      M[data_kept]='data kept in %s'
      M[which_capture]='profile to (re)capture cookies for: '
      M[login_url]='login URL (e.g. https://accounts.google.com): '
      M[empty_url]='empty URL'
      M[no_port]='no port'
      M[cap_warn1]="NOTE: temporarily STOPS the '%s' container (shared volume); the capture"
      M[cap_warn2]='      container runs with --network host; noVNC on loopback (127.0.0.1) only, no password.'
      M[cap_continue]='Continue?'
      M[cap_stop]='>>> stopping camofox-%s'
      M[cap_start]='>>> starting %s (--network host; REST :%s, noVNC :%s, x11vnc :%s)'
      M[cap_runfail]='!! docker run failed'
      M[cap_wait_engine]='>>> waiting for the engine'
      M[cap_health_no]='(health did not respond — check docker logs %s)'
      M[cap_opentab]='>>> opening a tab (userId=%s) at %s (first launch may take a while)…'
      M[cap_try]='    …attempt %s (browser starting)   '
      M[cap_tabok]='    ✓ tab opened'
      M[cap_tabfail]='    ! tab did not open — check: docker logs %s'
      M[cap_wait_draw]='>>> waiting for Camoufox to render (x11vnc attach)…'
      M[cap_up]='    ✓ Camoufox up, x11vnc attached (display %s)            '
      M[cap_attaching]='    …%ss vnc:attaching   '
      M[cap_noattach]='    ! x11vnc did not attach within 60s — check: docker logs %s        '
      M[cap_open_url]='  ── Open in your browser:  http://%s:%s/vnc.html'
      M[cap_login_here]='  ── Log in on the site (MFA/CAPTCHA — manually).'
      M[cap_enter]='  When done — press Enter to save the state… '
      M[cap_export]='>>> exporting storage_state (persistence writes it to the volume)'
      M[cap_captured]='>>> captured %s cookies.'
      M[cap_cleanup]='>>> removing %s'
      M[cap_restore]='>>> restoring the normal container'
      M[cap_done]=">>> Done. Future sessions with userId='%s' restore this login (persistence in %s)."
      M[loggedin_hdr]='  logged-in (has saved storage-state):'
      M[loggedin_none]='    (none)'
      M[yn]=' [y/N] '
      ;;
  esac
}
set_lang en   # дефолт (для `source` у тестах); інтерактивний вибір — у guard внизу

# друк шаблону: p key [args…] → рядок+\n ; pr key [args…] → без \n (для read/printf \r)
p()  { local k="$1"; shift; printf -- "${M[$k]}\n" "$@"; }
pr() { local k="$1"; shift; printf -- "${M[$k]}" "$@"; }

# ── низькорівневі помічники (усе, що торкає 0600-файл — через $SUDO) ──────────
pc()         { $SUDO $PROXYCTL -f "$FILE" "$@"; }
read_file()  { $SUDO cat "$FILE"; }
write_file() {
  local tmp; tmp="$(mktemp)"; cat > "$tmp"
  if [ -n "$SUDO" ]; then $SUDO install -m600 -o root -g root "$tmp" "$FILE"
  else install -m600 "$tmp" "$FILE"; fi
  rm -f "$tmp"
}
append_block() { { read_file; printf '%s' "$1"; } | write_file; }

confirm()   { local a; read -rp "$1$(pr yn)" a; [[ "$a" =~ ^[YyТт]$ ]]; }
list_ids()  { read_file | grep -oE '^\[profiles\.[^]]+\]' | sed -E 's/\[profiles\.(.+)\]/\1/'; }
has_login() { $SUDO bash -c "ls '$STATE_DIR/$1'/profiles/*/storage-state.json" >/dev/null 2>&1; }
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

host_owner() {     # port → "container:<name>" / "host-process" / порожньо
  local c n
  c="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | awk -v p=":$1->" 'index($0,p){print $1; exit}')"
  [ -n "$c" ] && { echo "container:$c"; return; }
  # host-network контейнери не показують .Ports у `docker ps` → зіставляємо порт з їх env
  # (CAMOFOX_PORT/NOVNC_PORT/VNC_PORT). Так осиротілий capture-контейнер видно як container:, а не host-process.
  for n in $(docker ps --filter network=host --filter name=camofox- --format '{{.Names}}' 2>/dev/null); do
    docker inspect "$n" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
      | grep -qE "^(CAMOFOX_PORT|NOVNC_PORT|VNC_PORT)=$1\$" && { echo "container:$n"; return; }
  done
  command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$1" 2>/dev/null | grep -q . && echo "host-process"
}

ask_port() {       # default [exclude_id] → ставить глобальну PORT з reprompt при колізії
  local def="$1" excl="${2:-}" p ow ho vc
  while true; do
    read -rp "$(pr port_prompt "$def")" p; PORT="${p:-$def}"
    if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then p port_num; continue; fi
    ow="$(port_owner "$PORT" "$excl")"
    if [ -n "$ow" ]; then p port_intoml "$PORT" "$ow"; continue; fi
    ho="$(host_owner "$PORT")"
    if [ -n "$ho" ] && [ "$ho" != "container:camofox-$excl" ]; then
      vc="${ho#container:}"
      # осиротілий capture-контейнер цього ж скрипта — можна безпечно прибрати й звільнити порт
      if [[ "$vc" == camofox-*-vnc ]] && confirm "$(pr port_kick "$vc")"; then
        $SUDO docker rm -f "$vc" >/dev/null 2>&1 || true; continue   # apply наприкінці підніме профіль
      fi
      p port_host "$PORT" "$ho"; continue
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
    p proxy_menu
    read -rp "$(pr proxy_choice)" m; m="${m:-1}"
    case "$m" in
      1) KIND=sticky; break;;
      2) KIND=sticky; read -rp "$(pr proxy_url)" PROXY   # TODO: secret-hygiene (deferred)
         read -rp "$(pr country_opt)" CC; break;;
      3) KIND=pool;   read -rp "$(pr pool_file)" PF
         read -rp "$(pr country_req)" CC; break;;
      *://*) KIND=sticky; PROXY="$m"; p proxy_accepted
         read -rp "$(pr country_opt)" CC; break;;
      *) p proxy_bad;;
    esac
  done
  if [ -n "$PROXY$PF" ] && [ -n "$CC" ]; then
    local a; read -rp "${M[locale_q]}$(pr yn)" a
    [[ "$a" =~ ^[YyТт]$ ]] && LOCALE=yes
  fi
}

maybe_capture() {  # id → ПІСЛЯ apply пропонує візуальний логін (VNC) для куки
  confirm "$(pr cap_offer "$1")" && do_capture "$1"
}

commit_apply() {   # $1 = шлях до файлу з НОВИМ повним вмістом profiles.toml.
  # Валідуємо той файл; реальний profiles.toml пишемо ЛИШЕ якщо валідний. Приймаємо
  # ФАЙЛ, а не stdin — інакше `read` у confirm читав би з pipe, а не з термінала.
  local src="$1"
  echo "== validate =="
  if ! $SUDO $PROXYCTL -f "$src" validate; then p val_fail; return 1; fi
  p plan_hdr; $SUDO $PROXYCTL -f "$src" apply   # dry-run ПРОТИ нового вмісту
  confirm "${M[confirm_apply]}" || { p cancelled; return 2; }
  if [ -n "$SUDO" ]; then $SUDO install -m600 -o root -g root "$src" "$FILE"
  else install -m600 "$src" "$FILE"; fi
  $SUDO $PROXYCTL -f "$FILE" apply --apply; return 0
}

do_create() {
  local id; read -rp "$(pr ask_id)" id; [ -z "$id" ] && { p empty_id; return; }
  list_ids | grep -qx "$id" && { p exists "$id"; return; }
  ask_port "$(next_port)"
  ask_proxy
  local blk; blk="$(gen_block "$id" "$KIND" "$CC" "$PORT" "$PROXY" "$PF" "$LOCALE")"
  p block_hdr; printf '%s\n' "$blk"; p block_sep
  local tmp; tmp="$(mktemp)"; { read_file; printf '%s' "$blk"; } > "$tmp"
  commit_apply "$tmp" && maybe_capture "$id"   # один confirm усередині; після apply — опц. VNC-логін
  rm -f "$tmp"
}

do_edit() {
  p profiles; list_ids | sed 's/^/  /'
  local id; read -rp "$(pr which_edit)" id
  list_ids | grep -qx "$id" || { p no_such; return; }
  local ckind ccc cport cproxy; IFS='|' read -r ckind ccc cport cproxy <<<"$(read_profile "$id")"
  p current "$ckind" "${ccc:-–}" "$cport" "${cproxy:+<set>}"
  local what; p edit_what_menu; read -rp "$(pr edit_what_choice)" what
  case "${what:-1}" in
    2) do_capture "$id"; return;;   # куки: одразу VNC-логін, toml не чіпаємо
  esac
  ask_port "$cport" "$id"
  ask_proxy
  local blk; blk="$(gen_block "$id" "$KIND" "$CC" "$PORT" "$PROXY" "$PF" "$LOCALE")"
  p newblock_hdr; printf '%s\n' "$blk"; p newblock_sep
  local tmp; tmp="$(mktemp)"; { remove_block "$id"; printf '%s' "$blk"; } > "$tmp"
  commit_apply "$tmp" && maybe_capture "$id"
  rm -f "$tmp"
}

do_delete() {
  p profiles; list_ids | sed 's/^/  /'
  local id; read -rp "$(pr which_delete)" id
  list_ids | grep -qx "$id" || { p no_such; return; }
  confirm "$(pr del_confirm "$id")" || return
  remove_block "$id" | write_file
  p prune_hdr; pc apply --apply --prune
  if confirm "$(pr del_data "$STATE_DIR/$id")"; then
    $SUDO rm -rf "${STATE_DIR:?}/$id" && p data_deleted
  else p data_kept "$STATE_DIR/$id"; fi
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

do_capture() {     # [id] — з Create/Edit; без арг → інтерактивний вибір (re-login)
  local id="${1:-}"
  if [ -z "$id" ]; then p profiles; list_ids | sed 's/^/  /'; read -rp "$(pr which_capture)" id; fi
  list_ids | grep -qx "$id" || { p no_such; return; }
  local uid="$id"   # userId сесії = id профілю
  local url; read -rp "$(pr login_url)" url
  [ -z "$url" ] && { p empty_url; return; }
  local cport; cport="$(read_profile "$id" | cut -d'|' -f3)"; [ -z "$cport" ] && { p no_port; return; }
  local nv=6080; while [ -n "$(host_owner "$nv")" ]; do nv=$((nv+1)); done
  local vp=5900; while [ -n "$(host_owner "$vp")" ]; do vp=$((vp+1)); done
  p cap_warn1 "$id"; p cap_warn2
  confirm "${M[cap_continue]}" || return

  local vname="camofox-$id-vnc" inline efarg="" envfile="$RUN_ENV_DIR/$id.env"
  local key; key="$(openssl rand -hex 16 2>/dev/null || echo "cfxcap$$")"   # ephemeral, лише для export
  inline="$(profile_inline_env "$id")"
  $SUDO test -e "$envfile" && efarg="--env-file $envfile"

  # Прибрати vnc-контейнер і підняти назад нормальний профіль. Ідемпотентно й через trap —
  # інакше Ctrl+C посеред логіну лишав би сироту на --network host, що тримає порт профілю.
  local _restored=0
  _restore() {
    [ "$_restored" = 1 ] && return; _restored=1; trap - INT TERM
    p cap_cleanup "$vname"; $SUDO docker rm -f "$vname" >/dev/null 2>&1 || true
    # rm -f перед apply: proxyctl бачить зупинений контейнер як "keep" і не перезапускає.
    p cap_restore; $SUDO docker rm -f "camofox-$id" >/dev/null 2>&1 || true; pc apply --apply
  }
  trap '_restore; exit 130' INT TERM

  p cap_stop "$id"; $SUDO docker stop "camofox-$id" >/dev/null 2>&1 || true
  p cap_start "$vname" "$cport" "$nv" "$vp"
  # --network host: інакше docker-publish приходить не як loopback → noVNC недосяжний
  # (websockify біндить loopback) і storage_state дає 403. shellcheck disable=SC2086
  $SUDO docker run -d --rm --name "$vname" --shm-size=2g --network host \
    -v "$STATE_DIR/$id:/root/.camofox" \
    -e CAMOFOX_PORT="$cport" -e NOVNC_PORT="$nv" -e VNC_PORT="$vp" -e CAMOFOX_API_KEY="$key" \
    -e BROWSER_IDLE_TIMEOUT_MS=0 \
    $efarg $inline -e ENABLE_VNC=1 \
    "$IMAGE" >/dev/null || { p cap_runfail; _restore; return 1; }

  p cap_wait_engine; curl -s --retry 60 --retry-delay 1 --retry-connrefused --max-time 120 "http://$BIND:$cport/health" >/dev/null || p cap_health_no "$vname"

  # Вкладка з РЕТРАЄМ: перший launch через проксі тягне GeoIP ~65МБ і може дати
  # timeout/гонку Xvfb. Повторюємо, поки не отримаємо tabId (без цього — чорний екран).
  p cap_opentab "$uid" "$url"
  local i resp tabok=0
  for i in $(seq 1 10); do
    resp="$(curl -s --max-time 80 -X POST "http://$BIND:$cport/tabs" -H 'content-type: application/json' \
      -d "{\"userId\":\"$uid\",\"sessionKey\":\"vnc\",\"url\":\"$url\"}" 2>/dev/null || true)"
    printf '%s' "$resp" | grep -q '"tabId"' && { tabok=1; break; }
    pr cap_try "$i"; sleep 2
  done
  [ "$tabok" = 1 ] && p cap_tabok || p cap_tabfail "$vname"

  # Чекаємо, поки x11vnc приатачиться до дисплея браузера (running:true).
  p cap_wait_draw
  local st ready=0 disp
  for i in $(seq 1 60); do
    st="$(curl -s --max-time 3 "http://$BIND:$cport/vnc/status" 2>/dev/null || true)"
    if printf '%s' "$st" | grep -q '"running":true'; then
      disp="$(printf '%s' "$st" | grep -oE '"display":"[^"]*"' | cut -d'"' -f4)"
      printf '\r'; p cap_up "${disp:-?}"
      ready=1; break
    fi
    pr cap_attaching "$i"; sleep 1
  done
  [ "$ready" = 1 ] || { printf '\r'; p cap_noattach "$vname"; }

  echo; p cap_open_url "$BIND" "$nv"
  p cap_login_here
  read -rp "$(pr cap_enter)" _

  p cap_export
  local tmpout; tmpout="$(mktemp)"
  curl -s "http://$BIND:$cport/sessions/$uid/storage_state" -H "Authorization: Bearer $key" -o "$tmpout"
  local nc; nc="$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1])).get("cookies",[])))' "$tmpout" 2>/dev/null || echo '?')"
  p cap_captured "$nc"
  rm -f "$tmpout"

  _restore
  p cap_done "$uid" "$STATE_DIR/$id"
}

do_list() {        # proxyctl ls (live status) + logged-in позначка з volume
  pc ls
  p loggedin_hdr
  local any=0 id
  while IFS= read -r id; do
    has_login "$id" && { echo "    ✓ $id"; any=1; }
  done < <(list_ids)
  [ "$any" = 0 ] && p loggedin_none
}

choose_lang() {    # інтерактивний вибір мови (перше на старті); або CAMOFOX_PROFILE_LANG
  local l="${CAMOFOX_PROFILE_LANG:-}"
  if [ -z "$l" ]; then
    echo "Language / Мова:  1) English   2) Українська"
    local c; read -rp "> " c
    case "$c" in 2|ua|UA|у*|У*) l=ua;; *) l=en;; esac
  fi
  case "$l" in ua|UA) set_lang ua;; *) set_lang en;; esac
}

menu() {
  while true; do
    echo; echo "=== camofox-profile ($FILE) ==="
    echo "${M[menu_line]}"
    local x; read -rp "> " x
    case "$x" in
      1) do_list;; 2) do_create;; 3) do_edit;; 4) do_delete;; 5) pc health;;
      q|Q) break;; *) p unknown;;
    esac
  done
}

# Запускати меню лише при прямому виклику; при `source` — доступні функції (для тестів).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  choose_lang
  menu
fi
