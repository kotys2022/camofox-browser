# =============================================================================
# camofox-browser.nix — Camoufox stealth-браузер (REST API :9377) для Hermes MCP.
#
# МОДЕЛЬ (fleet, поза декларативністю Nix — свідомо):
#   Nix тримає лише СТАТИКУ (rebuild-safe): docker, `proxyctl` у PATH, каталог стану,
#   і boot-oneshot `camofox-apply` = `proxyctl apply` (конвергенція флоту з toml).
#   Контейнери-профілі підіймає/супервізить сам docker (--restart=unless-stopped);
#   джерело істини — /var/lib/camofox/profiles.toml (рантайм-мутабельний, 0600).
#   Ребілд НЕ чіпає ні контейнери, ні /var/lib/camofox → дані профілів НЕ перезаписуються.
#
#   1 образ camofox-browser:local (спільний) → N контейнерів-профілів, кожен зі
#   своїм volume /var/lib/camofox/<id> (identity+куки) і своїм проксі. Керування —
#   `proxyctl` (ls/validate/apply/…); опис профілів — profiles.toml. Гайд
#   (архітектура + операції + розгортання): camofox-manager/USAGE.md.
#
#   ⚠ Образ будує deploy.sh (build_camofox_image) із форку kotys2022/camofox-browser
#     → camofox-browser:local (pull=never).
#
# Периметр: 127.0.0.1 + firewall закритий, БЕЗ auth (свідома trust-політика, secrets.nix).
# MCP-адаптер (hermes.nix) б'є в профіль `default` по loopback :9377.
# Вмикається: services.camofox-docker.enable.
# =============================================================================
{ config, lib, pkgs, ... }:
let
  cfg = config.services.camofox-docker;
  dockerBin = config.virtualisation.docker.package;

  # proxyctl: python-скрипт + docker у PATH. tomllib — stdlib py3.11+.
  proxyctl = pkgs.stdenvNoCC.mkDerivation {
    pname = "camofox-proxyctl";
    version = "0.1";
    src = ./camofox-manager;
    nativeBuildInputs = [ pkgs.makeWrapper ];
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/libexec $out/bin
      install -m0755 proxyctl $out/libexec/proxyctl
      makeWrapper ${pkgs.python3}/bin/python3 $out/bin/proxyctl \
        --add-flags $out/libexec/proxyctl \
        --prefix PATH : ${lib.makeBinPath [ dockerBin pkgs.curl ]}
      runHook postInstall
    '';
  };
in {
  options.services.camofox-docker = {
    enable = lib.mkEnableOption "Camoufox stealth browser fleet (docker + proxyctl)";
    port = lib.mkOption {
      type    = lib.types.port;
      default = 9377;
      description = "Порт хоста профілю `default` (loopback). Ціль MCP-адаптера Hermes.";
    };
    image = lib.mkOption {
      type    = lib.types.str;
      default = "camofox-browser:local";
      description = "Локальний docker-образ (deploy.sh build із форку). pull=never.";
    };
    stateDir = lib.mkOption {
      type    = lib.types.path;
      default = "/var/lib/camofox";
      description = "Каталог стану: <stateDir>/<id> = volume профілю; <stateDir>/profiles.toml.";
    };
    profilesFile = lib.mkOption {
      type    = lib.types.str;
      default = "/var/lib/camofox/profiles.toml";
      description = "Файл-джерело профілів (рантайм-мутабельний, 0600; НЕ Nix-store).";
    };
    package = lib.mkOption {
      type    = lib.types.package;
      default = proxyctl;
      description = "Пакет proxyctl (менеджер флоту).";
    };
  };

  config = lib.mkIf cfg.enable {
    virtualisation.docker.enable = lib.mkDefault true;
    environment.systemPackages = [ cfg.package ];
    # Зручні аліаси оператора (працюють у fish/bash, бо programs.fish.enable=true).
    # sudo вже ВСЕРЕДИНІ → пиши `pcx ls`, а не `sudo pcx`.
    environment.shellAliases =
      let base = "sudo proxyctl -f ${cfg.profilesFile}"; in {
        pcx       = base;                    # база: pcx <будь-яка-команда>
        pcxedit   = "sudoedit ${cfg.profilesFile}";  # редагувати profiles.toml
        pcxls     = "${base} ls";            # список профілів + статус
        pcxplan   = "${base} apply";         # dry-run: показати план
        pcxapply  = "${base} apply --apply"; # застосувати зміни
        pcxprune  = "${base} apply --apply --prune"; # застосувати + прибрати зайві
        pcxhealth = "${base} health";        # пінг усіх проксі
        pcxheal   = "${base} heal --apply";  # авто-заміна мертвих проксі
      };
    # 0700: profiles.toml містить проксі-креди.
    systemd.tmpfiles.rules = [ "d ${cfg.stateDir} 0700 root root - -" ];

    # ── Одноразова міграція legacy single-container → профіль `default` ──────────
    systemd.services.camofox-migrate = {
      description = "camofox: міграція legacy-контейнера в профіль default";
      after = [ "docker.service" ];
      requires = [ "docker.service" ];
      before = [ "camofox-apply.service" ];
      wantedBy = [ "multi-user.target" ];
      path = [ dockerBin pkgs.coreutils ];
      serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
      script = ''
        set -eu
        S=${cfg.stateDir}
        # 1) прибрати старий oci-контейнер `camofox` (якщо лишився з попередньої моделі)
        docker rm -f camofox 2>/dev/null || true
        # 2) перенести legacy-дані (том був /var/lib/camofox цілком) у default/ — раз
        if [ -e "$S/profiles" ] && [ ! -e "$S/default" ]; then
          mkdir -p "$S/default"
          for d in profiles cookies uploads traces; do
            [ -e "$S/$d" ] && mv "$S/$d" "$S/default/$d" || true
          done
        fi
        # 3) засіяти profiles.toml профілем default (порт = cfg.port), якщо файлу нема
        if [ ! -e ${cfg.profilesFile} ]; then
          umask 077
          printf '%s\n' \
            '[profiles.default]' \
            'kind = "sticky"   # без proxy = direct (можна додати proxy = "…" пізніше)' \
            'port = ${toString cfg.port}' \
            > ${cfg.profilesFile}
        fi
      '';
    };

    # ── Конвергенція флоту при завантаженні ─────────────────────────────────────
    systemd.services.camofox-apply = {
      description = "camofox: reconcile профіль-контейнерів із profiles.toml";
      after = [ "docker.service" "camofox-migrate.service" ];
      requires = [ "docker.service" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
      environment = {
        CAMOFOX_IMAGE = cfg.image;
        CAMOFOX_DATA_ROOT = cfg.stateDir;
      };
      script = "${cfg.package}/bin/proxyctl -f ${cfg.profilesFile} apply --apply";
    };
  };
}
