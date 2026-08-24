#cloud-config
autoinstall:
  version: 1
  identity:
    hostname: gridora-image-build
    username: gridora
    password: "!"
  ssh:
    install-server: true
    allow-pw: false
    authorized-keys:
      - ${build_ssh_public_key}
  storage:
    layout:
      name: direct
  packages: [qemu-guest-agent]
  late-commands:
    - curtin in-target --target=/target -- systemctl enable qemu-guest-agent
