inputs@{ self, nixpkgs, disko, sops-nix, oh-my-pi, deployment ? {} }: let
    system = "x86_64-linux";
    lib = nixpkgs.lib;
    codingLicense = package: lib.getName package == "claude-code";
    ompOverlay = final: _: {
      omp = oh-my-pi.packages.${final.stdenv.hostPlatform.system}.omp;
    };
    # VM tests reuse this package set read-only. Apply the license policy here,
    # rather than attempting to change their locked nixpkgs.config in base.
    pkgs = import nixpkgs {
      inherit system;
      config.allowUnfreePredicate = codingLicense;
      overlays = [ ompOverlay ];
    };
    # A dirty tree has no self.rev. Do not publish dirtyRev: it will never
    # match a system in the binary cache.
    revision = if (self.rev or null) != null then self.rev else "unknown";
    installerSettings = { sshKeys = (deployment.shared.sshKeys or (import ./settings/shared.nix).sshKeys); };
    # roles.json is the only definition of a role; roles.nix validates it.
    roles = import ./roles.nix { inherit lib; };
    toplevel = attr: hosts.${attr}.config.system.build.toplevel;
    # A settings file names its role; the registry names the closure. They must
    # agree, so a role's settings cannot be wired to another role's system.
    settingsFor = closure: let settings = import closure.settings; in
      if settings.role != closure.role
      then throw "${toString closure.settings} says role ${settings.role}; roles.json gives it to ${closure.role}"
      else lib.recursiveUpdate (lib.recursiveUpdate settings (deployment.shared or {}))
        ((deployment.roles.${closure.role} or {}) // { flakeAttr = closure.attr; });
    mkHost = settings: hostModule: lib.nixosSystem {
      inherit system;
      specialArgs = { inherit settings revision; };
      modules = [
        {
          nixpkgs.config.allowUnfreePredicate = codingLicense;
          nixpkgs.overlays = [ ompOverlay ];
        }
        disko.nixosModules.disko
        sops-nix.nixosModules.sops
        hostModule
      ];
    };
    hosts = builtins.listToAttrs (map (closure:
      lib.nameValuePair closure.attr (mkHost (settingsFor closure) closure.host)) roles.closures);
    # A role's own closure, without capability variants (ci, not ci-gpu).
    primaryHosts = lib.getAttrs roles.active hosts;
    installerIso = lib.nixosSystem {
      inherit system;
      specialArgs = { settings = installerSettings; };
      modules = [
        (nixpkgs + "/nixos/modules/installer/cd-dvd/installation-cd-minimal.nix")
        ./modules/installer.nix
        ./modules/installer-iso.nix
        {
          isoImage.storeContents = map toplevel roles.installer ++ [ installDisk ];
          isoImage.contents = [{
            source = pkgs.writeText "fleet-readiness.json" (builtins.toJSON {
              version = 1;
              roles = lib.genAttrs roles.installer (attr: {
                blocked = (builtins.fromJSON hosts.${attr}.config.environment.etc."fleet/bootstrap.json".text).installBlocked;
              });
            });
            target = "/fleet-readiness.json";
          } {
            source = pkgs.writeText "fleet-install-manifest"
              (lib.concatMapStrings (attr: "${attr} ${toplevel attr}\n") roles.installer
                + "disko ${installDisk}\n");
            target = "/fleet-install-manifest";
          }];
        }
      ];
    };
    # Every role shares this layout. The recorded path is checked again on the
    # target, then linked to the sentinel disko opens.
    installDisk = pkgs.writeShellScript "disko" ''
      set -euo pipefail
      export PATH=${lib.makeBinPath [ pkgs.python3 pkgs.util-linux pkgs.coreutils ]}:$PATH
      recorded=/run/fleet-install-disk
      [ -s "$recorded" ]
      device=$(tr -d '[:space:]' < "$recorded")
      [[ "$device" =~ ^/dev/[A-Za-z0-9._/:-]+$ ]]
      again=$(python3 ${./scripts/cattle.py} select-disk)
      [ "$again" = "$device" ]
      ln -sfn "$device" /dev/fleet-install-disk
      exec ${hosts.${roles.installerDefault}.config.system.build.diskoScript}
    '';
    bootstrapFor = pkgs': pkgs'.writeShellScript "bootstrap" ''
      export PATH=${lib.makeBinPath [ pkgs'.openssh ]}:$PATH
      exec ${pkgs'.bash}/bin/bash ${./scripts/bootstrap.sh} "$@"
    '';
    testArgs = {
      inherit pkgs;
      inherit (nixpkgs) lib;
      sopsModule = sops-nix.nixosModules.sops;
      diskoModule = disko.nixosModules.disko;
    };
  in {
    # The registry, for workflows and scripts that must not keep their own list:
    # nix eval --json .#lib.roles.published
    lib.mkFleet = config: import ./outputs.nix (inputs // {
      self = config.self or self;
      deployment = builtins.removeAttrs config [ "self" ];
    });
    lib.roles = { inherit (roles) known active installer published installerDefault; };
    # One evaluation for the cache probes (check-fleet-cache.ts, wait-cache.py):
    # every published closure path and the key that must have signed it.
    lib.cacheProbe = let
      bootstrap = builtins.fromJSON hosts.${roles.installerDefault}.config.environment.etc."fleet/bootstrap.json".text;
    in {
      metadata = { inherit (bootstrap) cacheUrl cachePublicKey; };
      paths = map (attr: toString (toplevel attr)) roles.published;
    };
    nixosConfigurations = hosts // { installer = installerIso; };
    # Every closure, including capability variants such as ci-gpu. Only
    # roles.published is built by default and by the Fleet cache workflow.
    packages.${system} = lib.mapAttrs (attr: _: toplevel attr) hosts // {
      node = self.packages.${system}.${roles.installerDefault};
      installer = installerIso.config.system.build.isoImage;
      fleet-installer = import ./modules/installer-package.nix { inherit pkgs lib revision; };
      fleet-node = self.packages.${system}.fleet-installer;
      # A revision-independent runtime closure shared by all CI check lanes.
      coding-tools = (import ./modules/coding-package.nix { inherit pkgs lib; }).session;
      default = self.packages.${system}.${roles.installerDefault};
      disko = installDisk;
      nixos-anywhere = pkgs.nixos-anywhere;
      bootstrap = bootstrapFor pkgs;
    };
    checks.${system} = lib.genAttrs roles.published (attr: toplevel attr) // {
      deployment-overrides = let
        configured = self.lib.mkFleet {
          shared.fleetApi.url = "https://fleet.example.org";
          shared.repo.pollSeconds = 60;
          roles.ci = {
            github = {
              scope = "repository";
              organization = "";
              repositories = [ ];
              runnerGroup = null;
              appId = "";
              installationId = "";
            };
            secretsFile = null;
          };
        };
        node = configured.nixosConfigurations.devbox.config;
        template = configured.nixosConfigurations.ci.config;
        valid = node.systemd.services.fleet-agent.environment.FLEET_API_URL == "https://fleet.example.org"
          && node.systemd.timers.fleet-sync.timerConfig.OnUnitInactiveSec == "60s"
          && builtins.attrNames template.services.github-runners == [ ]
          && (builtins.fromJSON template.environment.etc."fleet/bootstrap.json".text).installBlocked != [ ];
      in pkgs.runCommand "fleet-deployment-overrides" { } (
        if valid then "mkdir -p $out"
        else "echo 'deployment overrides were not applied' >&2; exit 1");
      devbox-vm = import ./tests/devbox.nix testArgs;
      native-vm = import ./tests/native.nix testArgs;
      installer = self.packages.${system}.installer;
      vm = import ./tests/vm.nix (testArgs // { settings = import ./fleet.nix; });
      lifecycle = import ./tests/lifecycle.nix testArgs;
      follow-up = import ./tests/follow-up.nix testArgs;
      update-units = import ./tests/update-units.nix { inherit pkgs lib; roles = hosts; };
      coding-units = import ./tests/coding-units.nix { inherit pkgs lib; roles = hosts; };
      coding-launcher = import ./tests/coding-launcher.nix { inherit pkgs lib; };
      # The complete registry rules and its files, from inside the build.
      roles = pkgs.runCommand "fleet-roles" { } ''
        ${pkgs.python3}/bin/python3 ${./scripts/fleet_roles.py} validate ${./.}
        mkdir -p "$out"
      '';
      cattle = pkgs.runCommand "fleet-cattle" { } ''
        ${pkgs.python3}/bin/python3 ${./scripts/cattle.py} check ${./.}
        mkdir -p "$out"
      '';
      cattle-vm = import ./tests/cattle.nix testArgs;
      wifi-vm = import ./tests/wifi.nix testArgs;
      # Every role reports to the fleet API. Pure evaluation: a role that loses
      # the unit, its boot target or its address fails here, not at a boot.
      agent-units = let
        url = deployment.shared.fleetApi.url or (import ./settings/shared.nix).fleetApi.url;
        working = system: let unit = system.config.systemd.services.fleet-agent or null; in
          (if url == "" then unit == null else unit != null
          && builtins.elem "multi-user.target" unit.wantedBy
          && unit.environment.FLEET_API_URL == url
          && lib.hasInfix "fleet-agent run" unit.serviceConfig.ExecStart);
        broken = lib.attrNames (lib.filterAttrs (_: system: !(working system)) primaryHosts);
      in pkgs.runCommand "fleet-agent-units" { } (
        if broken == [ ] then "mkdir -p $out"
        else "echo 'roles without a working fleet-agent: ${lib.concatStringsSep ", " broken}' >&2; exit 1");
    };
    apps.${system} = {
      bootstrap = { type = "app"; program = "${bootstrapFor pkgs}"; };
      fleet-installer = {
        type = "app";
        program = "${self.packages.${system}.fleet-installer}/bin/fleet-installer";
      };
      fleet-node = {
        type = "app";
        program = "${self.packages.${system}.fleet-node}/bin/fleet-node";
      };
    };
    packages.aarch64-linux.fleet-installer = import ./modules/installer-package.nix {
      pkgs = nixpkgs.legacyPackages.aarch64-linux;
      inherit lib revision;
    };
    apps.aarch64-linux.fleet-installer = {
      type = "app";
      program = "${self.packages.aarch64-linux.fleet-installer}/bin/fleet-installer";
    };
    packages.aarch64-linux.fleet-node = self.packages.aarch64-linux.fleet-installer;
    apps.aarch64-linux.fleet-node = {
      type = "app";
      program = "${self.packages.aarch64-linux.fleet-node}/bin/fleet-node";
    };
    apps.aarch64-darwin.bootstrap = {
      type = "app";
      program = "${bootstrapFor nixpkgs.legacyPackages.aarch64-darwin}";
    };
    apps.x86_64-darwin.bootstrap = {
      type = "app";
      program = "${bootstrapFor nixpkgs.legacyPackages.x86_64-darwin}";
    };
    packages.aarch64-darwin.nixos-anywhere = nixpkgs.legacyPackages.aarch64-darwin.nixos-anywhere;
    packages.x86_64-darwin.nixos-anywhere = nixpkgs.legacyPackages.x86_64-darwin.nixos-anywhere;
    formatter.${system} = pkgs.nixfmt;
    devShells.${system}.default = pkgs.mkShell {
      packages = with pkgs; [ just sops age shellcheck actionlint python3 nixfmt ];
    };
  }
