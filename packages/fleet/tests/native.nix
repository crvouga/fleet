{ pkgs, lib, sopsModule, diskoModule }: let
  # The devbox closure with nix-ld removed: the native fleet-installer package
  # must run without the compatibility loader every role currently enables.
  settings = import ../devbox.nix;
  nativeFixture = pkgs.runCommand "native-reinstall-fixture" {} ''
    mkdir -p "$out"
    cp ${./native_reinstall.py} "$out/native_reinstall.py"
    cp ${./iso_fixture.py} "$out/iso_fixture.py"
  '';
  boot = pkgs.writeShellScript "test-kexec" ''
    test -f "$(dirname "$FLEET_TEST_ACTIONS")/busy/draining"
    printf 'boot %s\n' "$*" >> "$FLEET_TEST_ACTIONS"
  '';
  control = pkgs.writeShellScript "test-runner-control" ''
    printf 'runner %s\n' "$*" >> "$FLEET_TEST_ACTIONS"
  '';
in pkgs.testers.runNixOSTest {
  name = "fleet-native";
  # No route to the fleet API in the VM: leave the agent out.
  node.specialArgs = { settings = settings // { repo = settings.repo // { timer = false; }; fleetApi = { url = ""; }; }; };
  nodes.machine = {
    imports = [ sopsModule diskoModule ../hosts/devbox.nix ];
    disko.enableConfig = lib.mkForce false;
    boot.loader.systemd-boot.enable = lib.mkForce false;
    programs.nix-ld.enable = lib.mkForce false;
    users.users.root.hashedPassword = lib.mkForce null;
    virtualisation = { memorySize = 3072; cores = 2; };
  };
  testScript = { nodes, ... }: assert !nodes.machine.programs.nix-ld.enable; ''
    start_all()
    machine.wait_for_unit("multi-user.target")
    machine.succeed("fleet-installer --selftest | grep -F 'SELFTEST OK'", timeout=120)
    machine.succeed("${pkgs.python3}/bin/python3 ${nativeFixture}/native_reinstall.py ${boot} ${control}", timeout=120)
  '';
}
