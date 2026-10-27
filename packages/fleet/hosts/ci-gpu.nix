{ ... }: {
  imports = [
    ./ci.nix
    ../modules/capabilities/gpu-nvidia.nix
  ];
}
