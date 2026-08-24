terraform {
  required_version = ">= 1.10.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.23.0"
    }
  }
}

# The provider reads CLOUDFLARE_API_TOKEN from the environment.
provider "cloudflare" {}
