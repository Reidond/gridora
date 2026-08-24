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
    - curtin in-target --target=/target -- install -d -m 0755 /etc/sudoers.d
    - 'printf "gridora ALL=(ALL) NOPASSWD:ALL\n" > /target/etc/sudoers.d/90-gridora-packer'
    - curtin in-target --target=/target -- chmod 0440 /etc/sudoers.d/90-gridora-packer
    - curtin in-target --target=/target -- visudo -cf /etc/sudoers.d/90-gridora-packer
    - curtin in-target --target=/target -- systemctl enable qemu-guest-agent
