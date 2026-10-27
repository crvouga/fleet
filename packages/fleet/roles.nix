# roles.json for Nix. The flake and its modules take every role list from here.
# scripts/fleet_roles.py enforces the complete rules (`nix flake check` runs it
# as checks.roles); this file asserts what the evaluation itself relies on, so a
# broken registry stops evaluation instead of building a wrong system.
{ lib }: let
  registry = builtins.fromJSON (builtins.readFile ./roles.json);
  require = condition: message: if condition then true else throw "roles.json: ${message}";
  isName = pattern: value: builtins.isString value && builtins.match pattern value != null;
  activeRoles = builtins.filter (role: role.state == "active") registry.roles;
  # Strings become paths only after the patterns below have matched them, so a
  # registry entry cannot name a file outside this package.
  closures = lib.concatMap (role: map (closure: {
    inherit (closure) attr installer published;
    role = role.name;
    host = ./. + "/${closure.host}";
    settings = ./. + "/${role.settings}";
  }) role.closures) activeRoles;
  known = map (role: role.name) registry.roles;
  active = map (role: role.name) activeRoles;
  attrs = map (closure: closure.attr) closures;
  valid =
    require (registry.version == 1) "version must be 1"
    && require (lib.all (role: builtins.elem role.state [ "active" "retired" ]) registry.roles) "state is active or retired"
    && require (lib.all (isName "[a-z][a-z0-9]{0,15}") known) "role names are lowercase, at most 16 characters"
    && require (lib.unique known == known) "role names repeat"
    && require (lib.unique attrs == attrs) "closure attrs repeat"
    && require (lib.all (role: isName "[a-z][a-z0-9-]{0,31}[.]nix" role.settings) activeRoles) "settings is a .nix file at the package root"
    && require (lib.all (role: lib.all (closure: closure.host == "hosts/${closure.attr}.nix") role.closures) activeRoles) "a closure's host is hosts/<attr>.nix"
    && require (lib.all (closure: closure.attr == closure.role || lib.hasPrefix "${closure.role}-" closure.attr) closures) "a closure is its role or <role>-<capability>"
    && require (lib.all (closure: closure.installer -> closure.attr == closure.role) closures) "only a role's own closure is on the installer"
    && require (lib.all (role: (builtins.head role.closures).attr == role.name) activeRoles) "a role's first closure is the role itself"
    && require (builtins.elem registry.installerDefault active) "installerDefault is an active role";
in
  assert valid; {
    # Every role in the registry. OpenTofu and Postgres keep state for each.
    inherit known;
    # Roles a machine may be installed, enrolled and updated as.
    inherit active;
    # One entry per buildable system: { attr role host settings installer published }.
    inherit closures;
    installerDefault = registry.installerDefault;
    # Closure attrs on the installer image; the first is the default boot entry.
    installer = [ registry.installerDefault ]
      ++ builtins.filter (attr: attr != registry.installerDefault)
        (map (closure: closure.attr) (builtins.filter (closure: closure.installer) closures));
    # Closure attrs the Fleet cache workflow builds, signs and publishes.
    published = map (closure: closure.attr) (builtins.filter (closure: closure.published) closures);
  }
