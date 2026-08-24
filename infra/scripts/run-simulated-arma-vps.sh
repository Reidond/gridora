#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
image=gridora-simulated-arma-vps:acceptance

docker build --file "$repository_root/infra/simulation/arma-vps/Dockerfile" --tag "$image" "$repository_root"
docker run --rm --privileged --cgroupns=host --name gridora-simulated-arma-vps "$image"
