# Values shared by every physical role. Not a per-machine file.
# Private keys, tokens, and age keys do not belong here.
{
  # Optional emergency SSH access. Empty is valid: the installer console runs
  # fleet-install, and the installed system has no remote login until keys
  # are committed here. The same list is used by the ISO and every role.
  sshKeys = [ ];

  # systemd-boot entries kept on the EFI partition. Older generations stay
  # bootable until this limit or the weekly garbage collection removes them.
  bootGenerationLimit = 8;

  # tries-left on the newest entry. A generation that never reaches
  # systemd-bless-boot falls through to the previous one.
  bootTries = 3;

  disk = {
    # fleet-disk fails when /nix or /boot is at or above this percent.
    # The failure is also reported in the heartbeat to the fleet controller
    # (packages/fleet-controller), so it shows on the dashboard.
    alertPercent = 90;
  };

  # The fleet controller (packages/fleet-controller). Every node reports to it with a
  # heartbeat and receives its dynamic settings from it: sync pause, reboot
  # policy, disk alert, capacity, runner repositories and labels. It sends data,
  # never code, and a node works without it: unreachable means the last
  # applied settings and the values in this file stay in force. Empty or a URL
  # containing TODO leaves the agent out of the image. docs/dynamic-config.md
  # lists every key. The role token that lets a node register without a
  # person is not here; the installer places it on the machine.
  fleetApi = {
    url = ""; # Optional: your Fleet controller HTTPS origin.
  };

  # Central monitoring is the fleet controller (fleetApi.url): every node reports a
  # heartbeat to it. pushUrl is not read and stays null. Logs stay in the
  # journal and metrics stay on 127.0.0.1:9101.
  monitoring = {
    pushUrl = null;
  };

  repo = {
    # Every role polls main over HTTPS. There is no deploy branch and no
    # canary branch.
    url = "TODO"; # Set your Git update source; no hosting provider is assumed.
    flakeDir = "packages/fleet";
    branch = "main";
    pollSeconds = 300;
    # none until a read-only deploy key or token is encrypted into this role's
    # sops file. Then set "ssh" or "token". CI and web still use different age keys.
    auth = "none";
    # Required for SSH Git sources: operator-supplied public host-key pins.
    sshKnownHosts = "";
    # Tests and broken configs can install the script without starting the timer.
    timer = true;
  };

  binaryCache = {
    # Private hosting is retired. Nodes build missing closures locally and use
    # the standard upstream Nix cache for published dependencies.
    url = null;
    publicKey = null;
  };

  # One formula for every CI machine, applied at boot by scripts/cattle.py:
  # min(slotMax, max(1, min(cores / perRunnerCores, (MemTotal MiB - reserveGiB*1024) / (perRunnerGiB*1024)))).
  # high-mem when MemTotal MiB is strictly above highMemGiB * 1024. 60 GiB
  # tags a 64 GiB box (MemTotal is a bit under 64) and not a 32 GiB box.
  capacity = {
    reserveGiB = 4;
    perRunnerGiB = 6;
    perRunnerCores = 2;
    slotMax = 8;
    highMemGiB = 60;
  };

  # How long origin/main may be ahead before fleet-drift fails.
  # The poll is repo.pollSeconds. A fresh merge stays inside this window.
  drift = {
    maxMinutes = 30;
  };

  reboot = {
    # Spread kernel reboots across this many seconds using the stable node id.
    delayMaxSeconds = 7200;
    # CI sets this to fleet-drain. Other roles leave it empty.
    drainCommand = "";
    drainTimeoutSeconds = 7200;
  };
}
