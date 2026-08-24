#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' 'The project-quota integration proof requires root.' >&2
  exit 1
fi

readonly image=/gridora-servers.ext4
readonly mountpoint=/servers
loop_device=''

cleanup() {
  mountpoint -q "$mountpoint" && umount "$mountpoint"
  [[ -z "$loop_device" ]] || losetup --detach "$loop_device"
}
trap cleanup EXIT

fallocate --length 268435456 "$image"
mkfs.ext4 -q -F -O quota,project -E nodiscard,quotatype=prjquota "$image"
mkdir "$mountpoint"
# GitHub-hosted runner containers do not always receive loop device nodes even
# with --privileged. Create only the standard loop-control and block-device
# nodes, then bind the image explicitly so mount never relies on implicit
# libmount/udev discovery inside the disposable container.
if [[ ! -e /dev/loop-control ]]; then
  mknod -m 0600 /dev/loop-control c 10 237
fi
for index in {0..63}; do
  if [[ ! -e "/dev/loop${index}" ]]; then
    mknod -m 0600 "/dev/loop${index}" b 7 "$index"
  fi
done
loop_device="$(losetup --find --show "$image")"
readonly loop_device
mount -o nodev,nosuid,prjquota "$loop_device" "$mountpoint"
mkdir "$mountpoint/server-1"
chown 10001:10001 "$mountpoint/server-1"
chattr -R -p 1000000000 "$mountpoint/server-1"
find "$mountpoint/server-1" -xdev -type d -exec chattr +P {} +
setquota -P 1000000000 1024 1024 0 0 "$mountpoint"

quota_row="$(repquota -P -O csv "$mountpoint" | grep '^#1000000000,')"
IFS=, read -r project _block_status _file_status _used soft hard _rest <<<"$quota_row"
test "$project" = '#1000000000'
test "$soft" = 1024
test "$hard" = 1024

attributes="$(lsattr -d -p "$mountpoint/server-1")"
read -r project_id project_flags _path <<<"$attributes"
test "$project_id" = 1000000000
case "$project_flags" in
  *P*) ;;
  *) exit 1 ;;
esac

set +e
setpriv --reuid=10001 --regid=10001 --clear-groups \
  dd if=/dev/zero of="$mountpoint/server-1/exhaustion.bin" bs=1M count=4 conv=fsync status=none
readonly write_status=$?
set -e
test "$write_status" -ne 0
