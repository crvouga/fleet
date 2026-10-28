# roles.json for Nix. The flake and its modules take every role list from here.
# scripts/fleet_roles.py enforces the complete rules (`nix flake check` runs it
# as checks.roles); this file asserts what the evaluation itself relies on, so a
# broken registry stops evaluation instead of building a wrong system.
#
# Roles are assigned by the fleet controller after installation. Every machine
# installs the role-less base closure, which is defined here rather than in
# roles.json (see ARCHITECTURE.md). Version 1 registries still carry
# installerDefault and per-closure installer flags; they are ignored.
{ lib }: let
  registry = builtins.fromJSON (builtins.readFile ./roles.json);
  require = condition: message: if condition then true else throw "roles.json: ${message}";
  isName = pattern: value: builtins.isString value && builtins.match pattern value != null;
  activeRoles = builtins.filter (role: role.state == "active") registry.roles;
  # Strings become paths only after the patterns below have matched them, so a
  # registry entry cannot name a file outside this package.
  closures = lib.concatMap (role: map (closure: {
    inherit (closure) attr published;
    role = role.name;
    host = ./. + "/${closure.host}";
    settings = ./. + "/${role.settings}";
  }) role.closures) activeRoles;
  base = {
    attr = "base";
    role = "base";
    published = true;
    host = ./hosts/base.nix;
    settings = ./base.nix;
  };
  known = map (role: role.name) registry.roles;
  active = map (role: role.name) activeRoles;
  attrs = map (closure: closure.attr) closures;
  valid =
    require (builtins.elem registry.version [ 1 2 ]) "version must be 2 (or 1 during the rollout)"
    && require (lib.all (role: builtins.elem role.state [ "active" "retired" ]) registry.roles) "state is active or retired"
    && require (lib.all (isName "[a-z][a-z0-9]{0,15}") known) "role names are lowercase, at most 16 characters"
    && require (!(builtins.elem "base" known)) "base is the role-less closure, not a role"
    && require (lib.unique known == known) "role names repeat"
    && require (lib.unique attrs == attrs) "closure attrs repeat"
    && require (lib.all (role: isName "[a-z][a-z0-9-]{0,31}[.]nix" role.settings) activeRoles) "settings is a .nix file at the package root"
    && require (lib.all (role: lib.all (closure: closure.host == "hosts/${closure.attr}.nix") role.closures) activeRoles) "a closure's host is hosts/<attr>.nix"
    && require (lib.all (closure: closure.attr == closure.role || lib.hasPrefix "${closure.role}-" closure.attr) closures) "a closure is its role or <role>-<capability>"
    && require (lib.all (role: (builtins.head role.closures).attr == role.name) activeRoles) "a role's first closure is the role itself";
in
  assert valid; {
    # Every role in the registry.
    inherit known;
    # Roles the controller may assign and nodes may converge to.
    inherit active;
    # The role-less closure on the installer image. Every machine installs it.
    inherit base;
    # One entry per buildable system, base first: { attr role host settings published }.
    closures = [ base ] ++ closures;
    # Closure attrs the Fleet cache workflow builds and publishes.
    published = [ base.attr ] ++ map (closure: closure.attr) (builtins.filter (closure: closure.published) closures);
  }
