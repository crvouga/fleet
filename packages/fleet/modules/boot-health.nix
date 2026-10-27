{ config, lib, pkgs, ... }: {
  # systemd 260's bless generator pulls the unit in from basic.target when
  # LoaderBootCountPath is set. boot-complete must wait for our health check.
  config = lib.mkIf config.boot.loader.systemd-boot.enable {
    systemd.services.fleet-boot-health = {
      description = "Verify the update recovery channel before blessing this boot";
      requiredBy = [ "boot-complete.target" ];
      before = [ "boot-complete.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      path = [ pkgs.coreutils pkgs.curl pkgs.python3 pkgs.systemd ];
      environment = {
        FLEET_BLESS = "${pkgs.systemd}/lib/systemd/systemd-bless-boot";
      };
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        Restart = "on-failure";
        RestartSec = "30s";
        ExecStart = "${pkgs.bash}/bin/bash ${../scripts/boot-health.sh}";
        # A failed dependency may have failed the original bless job. Once a
        # first boot recovers, queue it again without waiting on ourselves.
        ExecStartPost = "${pkgs.systemd}/bin/systemctl --no-block start systemd-bless-boot.service";
      };
    };
  };
}
