{
  description = "Example operator-owned Fleet deployment";
  inputs.fleet.url = "github:crvouga/fleet?dir=packages/fleet";
  outputs = { self, fleet }: fleet.lib.mkFleet {
    inherit self;
    shared = {
      repo = {
        # Set this to the repository containing this deployment flake.
        url = "https://github.com/TODO/DEPLOYMENT.git";
        flakeDir = ".";
      };
      # Supply your public SSH keys before installing a development box.
      sshKeys = [ ];
      # Leave empty for local approval; set your HTTPS API for managed approval.
      fleetApi.url = "";
    };
    # Configure roles.ci.github and roles.ci.secretsFile to enable CI installation.
  };
}
