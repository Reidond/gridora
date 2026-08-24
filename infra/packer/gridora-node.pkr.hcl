packer {
  required_version = ">= 1.11.0"
  required_plugins {
    qemu = {
      version = "= 1.1.6"
      source  = "github.com/hashicorp/qemu"
    }
  }
}

variable "ubuntu_iso_url" {
  type        = string
  description = "Pinned Ubuntu 24.04 LTS server ISO URL"
}

variable "ubuntu_iso_checksum" {
  type        = string
  description = "sha256 checksum from the Ubuntu signed checksum manifest"
}

variable "image_version" {
  type        = string
  description = "Immutable version such as 2026-08-23.1"
}

variable "source_commit" {
  type        = string
  description = "Reviewed 40-character source commit in the signed image identity"
}

variable "image_identity_manifest" {
  type        = string
  description = "Path to the strict signed build identity JSON"
}

variable "image_identity_signature" {
  type        = string
  description = "Path to the detached Ed25519 signature for the build identity"
}

variable "image_identity_public_key" {
  type        = string
  description = "Path to the Ed25519 public verification key"
}

variable "agent_binary" {
  type        = string
  description = "Path to the verified gridora-agent amd64 artifact"
}

variable "agent_binary_checksum" {
  type        = string
  description = "SHA-256 checksum for the reviewed agent artifact"
}

variable "agent_update_manifest" {
  type        = string
  description = "Path to the signed baseline agent-update manifest for the baked agent artifact"
}

variable "agent_update_release_signing_public_key" {
  type        = string
  description = "Path to the Ed25519 public key that verifies signed agent-update manifests"
}

variable "agent_update_policy" {
  type        = string
  description = "Path to the root-owned static agent-update source and size policy"
}

variable "node_archive" {
  type        = string
  description = "Path to the verified Node.js 24 Linux amd64 tar.xz archive"
}

variable "node_archive_checksum" {
  type        = string
  description = "SHA-256 checksum for the Node.js runtime archive"
}

variable "node_version" {
  type        = string
  default     = "24.19.0"
  description = "Pinned Node.js LTS version used by the agent"
}

variable "cloudflared_binary" {
  type        = string
  description = "Path to the verified cloudflared amd64 artifact"
}

variable "cloudflared_binary_checksum" {
  type        = string
  description = "SHA-256 checksum for the cloudflared artifact"
}

variable "traefik_binary" {
  type        = string
  description = "Path to the verified Traefik amd64 artifact"
}

variable "traefik_binary_checksum" {
  type        = string
  description = "SHA-256 checksum for the Traefik artifact"
}

variable "build_ssh_public_key" {
  type        = string
  description = "Path to an ephemeral Packer SSH public key"
}

variable "build_ssh_private_key" {
  type        = string
  description = "Path to the matching ephemeral Packer SSH private key"
}

source "qemu" "ubuntu" {
  accelerator = "kvm"
  boot_command = [
    "c<wait>",
    "linux /casper/vmlinuz autoinstall ip=dhcp ds=\"nocloud-net;s=http://{{ .HTTPIP }}:{{ .HTTPPort }}/\" ---<enter><wait>",
    "initrd /casper/initrd<enter><wait>",
    "boot<enter>"
  ]
  boot_wait        = "5s"
  cpus             = 2
  disk_compression = true
  disk_interface   = "virtio"
  disk_size        = "16384M"
  format           = "qcow2"
  headless         = true
  http_content = {
    "/meta-data" = file("http/meta-data")
    "/user-data" = templatefile("http/user-data.pkrtpl.hcl", {
      build_ssh_public_key = trimspace(file(var.build_ssh_public_key))
    })
  }
  iso_checksum         = var.ubuntu_iso_checksum
  iso_url              = var.ubuntu_iso_url
  memory               = 2048
  net_device           = "virtio-net"
  output_directory     = "dist/image-${var.image_version}"
  shutdown_command     = "sudo rm -f /home/gridora/.ssh/authorized_keys && sudo shutdown -P now"
  ssh_private_key_file = var.build_ssh_private_key
  ssh_timeout          = "30m"
  ssh_username         = "gridora"
  vm_name              = "gridora-node-${var.image_version}-amd64.qcow2"
}

build {
  name    = "gridora-node"
  sources = ["source.qemu.ubuntu"]

  provisioner "file" {
    source      = "${path.root}/../images/"
    destination = "/tmp/gridora-image"
  }

  provisioner "file" {
    source      = var.agent_binary
    destination = "/tmp/gridora-agent"
  }

  provisioner "file" {
    source      = var.agent_update_manifest
    destination = "/tmp/gridora-agent-update-manifest.json"
  }

  provisioner "file" {
    source      = var.agent_update_release_signing_public_key
    destination = "/tmp/gridora-agent-release-signing-public.pem"
  }

  provisioner "file" {
    source      = var.agent_update_policy
    destination = "/tmp/gridora-agent-update-policy.json"
  }

  provisioner "file" {
    source      = var.node_archive
    destination = "/tmp/node-runtime.tar.xz"
  }

  provisioner "file" {
    source      = var.cloudflared_binary
    destination = "/tmp/cloudflared"
  }

  provisioner "file" {
    source      = var.traefik_binary
    destination = "/tmp/traefik"
  }

  provisioner "file" {
    source      = var.image_identity_manifest
    destination = "/tmp/gridora-image-identity.json"
  }

  provisioner "file" {
    source      = var.image_identity_signature
    destination = "/tmp/gridora-image-identity.sig"
  }

  provisioner "file" {
    source      = var.image_identity_public_key
    destination = "/tmp/gridora-image-identity-public.pem"
  }

  provisioner "shell" {
    environment_vars = [
      "GRIDORA_IMAGE_VERSION=${var.image_version}",
      "GRIDORA_SOURCE_COMMIT=${var.source_commit}",
      "GRIDORA_AGENT_BINARY_CHECKSUM=${var.agent_binary_checksum}",
      "GRIDORA_CLOUDFLARED_BINARY_CHECKSUM=${var.cloudflared_binary_checksum}",
      "GRIDORA_NODE_ARCHIVE_CHECKSUM=${var.node_archive_checksum}",
      "GRIDORA_NODE_VERSION=${var.node_version}",
      "GRIDORA_TRAEFIK_BINARY_CHECKSUM=${var.traefik_binary_checksum}",
      "GRIDORA_UBUNTU_ISO_CHECKSUM=${trimprefix(var.ubuntu_iso_checksum, "sha256:")}"
    ]
    script = "${path.root}/scripts/provision.sh"
  }
}
