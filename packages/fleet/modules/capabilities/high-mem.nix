{ ... }: {
  # high-mem is not a NixOS system. cattle.py compares MemTotal with
  # capacity.highMemGiB from /etc/fleet/node.conf at boot.
  # A machine above the threshold gains the hostname tag highmem and the
  # runner label high-mem. Do not add a high-mem host or a second closure.
}
