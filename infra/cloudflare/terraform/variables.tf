variable "account_id" {
  type        = string
  description = "Cloudflare account ID"
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be a 32-character lowercase hexadecimal ID."
  }
}

variable "environment" {
  type        = string
  description = "Gridora environment name"
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "enable_resource_creation" {
  type        = bool
  default     = false
  description = "Explicit operator gate. The default plan creates no Cloudflare resource."
}

variable "enable_access_applications" {
  type        = bool
  default     = false
  description = "Explicit gate for the one multi-domain human Access application and the more-specific origin-authenticated path applications. Resource creation must also be enabled."
}

variable "zone_name" {
  type        = string
  default     = "gridora.example"
  description = "Managed Cloudflare zone that owns the reviewed Gridora hostnames"
  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,62}\\.)+[a-z]{2,63}$", var.zone_name))
    error_message = "zone_name must be a lowercase DNS zone name."
  }
}

variable "console_hostname" {
  type        = string
  default     = "console.gridora.example"
  description = "Authenticated Gridora console hostname"
  validation {
    condition = var.console_hostname == format(
      "%s.%s",
      var.environment == "production" ? "console" : format("console.%s", var.environment),
      var.zone_name,
    )
    error_message = "console_hostname must be console.<zone_name> in production or console.<environment>.<zone_name> outside production."
  }
}

variable "public_app_hostname" {
  type        = string
  default     = "app.gridora.example"
  description = "Public Gridora authentication-entry hostname"
  validation {
    condition = var.public_app_hostname == format(
      "%s.%s",
      var.environment == "production" ? "app" : format("app.%s", var.environment),
      var.zone_name,
    )
    error_message = "public_app_hostname must be app.<zone_name> in production or app.<environment>.<zone_name> outside production."
  }
}

variable "api_hostname" {
  type        = string
  default     = "api.gridora.example"
  description = "Access-protected Gridora API hostname"
  validation {
    condition = var.api_hostname == format(
      "%s.%s",
      var.environment == "production" ? "api" : format("api.%s", var.environment),
      var.zone_name,
    )
    error_message = "api_hostname must be api.<zone_name> in production or api.<environment>.<zone_name> outside production."
  }
}

variable "dns_target_hostname" {
  type        = string
  default     = "nodes.gridora.example"
  description = "Reviewed DNS target hostname used for game-node records"
  validation {
    condition = var.dns_target_hostname == format(
      "%s.%s",
      var.environment == "production" ? "nodes" : format("nodes.%s", var.environment),
      var.zone_name,
    )
    error_message = "dns_target_hostname must be nodes.<zone_name> in production or nodes.<environment>.<zone_name> outside production."
  }
}

variable "access_browser_session_duration" {
  type        = string
  default     = "24h"
  description = "Access browser session duration"
  validation {
    condition     = can(regex("^[1-9][0-9]*(?:m|h)$", var.access_browser_session_duration))
    error_message = "access_browser_session_duration must use a positive minute or hour duration."
  }
}

variable "access_oauth_token_lifetime" {
  type        = string
  default     = "15m"
  description = "Managed OAuth access-token lifetime for the CLI"
  validation {
    condition     = can(regex("^[1-9][0-9]*(?:m|h)$", var.access_oauth_token_lifetime))
    error_message = "access_oauth_token_lifetime must use a positive minute or hour duration."
  }
}

variable "access_oauth_grant_duration" {
  type        = string
  default     = "336h"
  description = "Managed OAuth refresh-grant session duration for the CLI"
  validation {
    condition     = can(regex("^[1-9][0-9]*(?:m|h)$", var.access_oauth_grant_duration))
    error_message = "access_oauth_grant_duration must use a positive minute or hour duration."
  }
}

variable "d1_jurisdiction" {
  type        = string
  default     = "eu"
  description = "D1 data jurisdiction"
}

variable "r2_location" {
  type        = string
  default     = "WEUR"
  description = "R2 location hint"
}
