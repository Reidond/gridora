#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' 'The project-quota integration proof requires root.' >&2
  exit 1
fi

readonly image=/gridora-servers.ext4
readonly mountpoint=/servers

cleanup() {
  mountpoint -q "$mountpoint" && umount "$mountpoint"
}
trap cleanup EXIT

fallocate --length 268435456 "$image"
mkfs.ext4 -q -F -O quota,project -E nodiscard,quotatype=prjquota "$image"
mkdir "$mountpoint"
mount -o loop,nodev,nosuid,prjquota "$image" "$mountpoint"
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
