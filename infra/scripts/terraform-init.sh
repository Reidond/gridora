#!/usr/bin/env sh
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
terraform_directory="${GRIDORA_TERRAFORM_DIRECTORY:-$root/infra/cloudflare/terraform}"
backend_declaration="$terraform_directory/backend.remote.tf"

usage() {
  printf '%s\n' 'usage: infra/scripts/terraform-init.sh offline|remote <staging|production>' >&2
  exit 2
}

require_environment() {
  environment="$1"
  if [ "$environment" != 'staging' ] && [ "$environment" != 'production' ]; then
    printf '%s\n' 'Terraform state environment must be staging or production.' >&2
    exit 2
  fi
}

require_value() {
  name="$1"
  value="$2"
  if [ -z "$value" ]; then
    printf 'Missing required protected input: %s\n' "$name" >&2
    exit 2
  fi
}

require_match() {
  name="$1"
  value="$2"
  expression="$3"
  description="$4"
  if ! printf '%s' "$value" | grep -Eq "$expression"; then
    printf 'Invalid protected input %s: %s\n' "$name" "$description" >&2
    exit 2
  fi
}

mode="${1:-}"
case "$mode" in
  offline)
    if [ "$#" -ne 1 ]; then usage; fi
    if [ -f "$backend_declaration" ]; then
      printf '%s\n' 'Remote backend declaration exists. Run the protected remote workflow or use a clean checkout for offline validation.' >&2
      exit 2
    fi
    exec terraform -chdir="$terraform_directory" init -backend=false -input=false -lockfile=readonly
    ;;
  remote)
    if [ "$#" -ne 2 ]; then usage; fi
    environment="$2"
    require_environment "$environment"
    require_value GRIDORA_TERRAFORM_STATE_BUCKET "${GRIDORA_TERRAFORM_STATE_BUCKET:-}"
    require_value GRIDORA_R2_ACCOUNT_ID "${GRIDORA_R2_ACCOUNT_ID:-}"
    require_value AWS_ACCESS_KEY_ID "${AWS_ACCESS_KEY_ID:-}"
    require_value AWS_SECRET_ACCESS_KEY "${AWS_SECRET_ACCESS_KEY:-}"
    require_match GRIDORA_TERRAFORM_STATE_BUCKET "$GRIDORA_TERRAFORM_STATE_BUCKET" \
      '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' \
      'must be a 3-63 character lowercase R2 bucket name'
    require_match GRIDORA_R2_ACCOUNT_ID "$GRIDORA_R2_ACCOUNT_ID" \
      '^[0-9a-f]{32}$' \
      'must be a 32-character lowercase Cloudflare account ID'

    if [ ! -d "$terraform_directory" ]; then
      printf 'Terraform directory does not exist: %s\n' "$terraform_directory" >&2
      exit 2
    fi
    if [ -f "$backend_declaration" ]; then
      expected_backend='terraform {
  backend "s3" {}
}'
      if [ "$(cat "$backend_declaration")" != "$expected_backend" ]; then
        printf 'Refusing to overwrite an unrecognized backend declaration: %s\n' "$backend_declaration" >&2
        exit 2
      fi
    else
      # Backend blocks cannot use variables. This ignored, non-secret file
      # selects the backend type; all account and credential values remain in
      # process environment or the protected init invocation below.
      (umask 077 && printf 'terraform {\n  backend "s3" {}\n}\n' > "$backend_declaration")
    fi

    # The S3 backend reads the R2 access key from the process environment. Do
    # not pass it by command line or write it into .terraform metadata.
    export AWS_EC2_METADATA_DISABLED=true
    # HashiCorp documents AWS_ENDPOINT_URL_S3 as the current nested S3 endpoint
    # override. It avoids the deprecated flat `endpoint` setting and the
    # unsupported `-backend-config=endpoints.s3=...` command-line form.
    export AWS_ENDPOINT_URL_S3="https://${GRIDORA_R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
    exec terraform -chdir="$terraform_directory" init -reconfigure -input=false -lockfile=readonly \
      -backend-config="bucket=${GRIDORA_TERRAFORM_STATE_BUCKET}" \
      -backend-config="key=gridora/${environment}/terraform.tfstate" \
      -backend-config='region=auto' \
      -backend-config='skip_credentials_validation=true' \
      -backend-config='skip_metadata_api_check=true' \
      -backend-config='skip_region_validation=true' \
      -backend-config='skip_requesting_account_id=true' \
      -backend-config='skip_s3_checksum=true' \
      -backend-config='use_path_style=true' \
      -backend-config='use_lockfile=true'
    ;;
  *)
    usage
    ;;
esac
