# A throwaway Linux x86-64 machine with real root, real block devices and a
# real ISO mastering tool. Nothing here touches the host's disks.
FROM --platform=linux/amd64 ubuntu:24.04 # hadolint ignore=DL3029
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip libpython3.12 binutils xorriso util-linux dosfstools e2fsprogs kmod curl ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir "pyinstaller>=6,<7"
