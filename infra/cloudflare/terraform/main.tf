locals {
  prefix = "gridora-${var.environment}"
  worker_names = {
    api             = "${local.prefix}-api"
    web             = "${local.prefix}-web"
    realtime        = "${local.prefix}-realtime"
    workflows       = "${local.prefix}-workflows"
    queue_consumers = "${local.prefix}-queue-consumers"
  }
  queues = toset([
    "agent-events",
    "audit-export",
    "notifications",
    "outbox-publisher",
    "policy-reconciliation",
    "reconciliation",
    "telemetry",
  ])
  dead_letter_queues = toset([
    "agent-events-dlq",
    "audit-export-dlq",
    "notifications-dlq",
    "outbox-publisher-dlq",
    "policy-reconciliation-dlq",
    "reconciliation-dlq",
    "telemetry-dlq",
  ])
  queue_names = {
    for queue in local.queues : queue => "${local.prefix}-${queue}"
  }
  dead_letter_queue_names = {
    for queue in local.dead_letter_queues : queue => "${local.prefix}-${queue}"
  }
  r2_buckets = toset([
    "artifacts",
    "audit-archive",
    "backups",
    "logs",
    "notification-remediation",
  ])
  r2_bucket_names = {
    for bucket in local.r2_buckets : bucket => "${local.prefix}-${bucket}"
  }
  access_origin_authenticated_paths = {
    agent    = "/v1/agent/*"
    internal = "/v1/internal/*"
  }
}

resource "cloudflare_d1_database" "gridora" {
  count        = var.enable_resource_creation ? 1 : 0
  account_id   = var.account_id
  name         = local.prefix
  jurisdiction = var.d1_jurisdiction

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "data" {
  for_each   = var.enable_resource_creation ? local.r2_buckets : toset([])
  account_id = var.account_id
  name       = local.r2_bucket_names[each.key]
  location   = var.r2_location

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_queue" "events" {
  for_each   = var.enable_resource_creation ? local.queues : toset([])
  account_id = var.account_id
  queue_name = local.queue_names[each.key]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_queue" "dead_letters" {
  for_each   = var.enable_resource_creation ? local.dead_letter_queues : toset([])
  account_id = var.account_id
  queue_name = local.dead_letter_queue_names[each.key]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "console_api" {
  count      = var.enable_resource_creation && var.enable_access_applications ? 1 : 0
  account_id = var.account_id
  name       = "${local.prefix}-console-api"
  domain     = var.console_hostname
  type       = "self_hosted"

  # A single multi-domain application lets Access issue application cookies for
  # both concrete browser origins during the initial eager redirect. A separate
  # API application would require the SPA user to visit and authenticate to the
  # API hostname before credentialed cross-origin requests could succeed.
  destinations = [{
    type = "public"
    uri  = var.console_hostname
    }, {
    type = "public"
    uri  = var.api_hostname
  }]

  app_launcher_visible       = true
  enable_binding_cookie      = true
  http_only_cookie_attribute = true
  session_duration           = var.access_browser_session_duration

  cors_headers = {
    allow_credentials = true
    allowed_headers = [
      "content-type",
      "idempotency-key",
      "x-correlation-id",
      "x-gridora-auth-state",
      "x-request-id",
    ]
    allowed_methods = ["GET", "POST", "PUT", "PATCH", "DELETE"]
    allowed_origins = [
      "https://${var.console_hostname}",
    ]
    max_age = 600
  }

  oauth_configuration = {
    enabled = true
    dynamic_client_registration = {
      enabled                = true
      allow_any_on_localhost = true
      allow_any_on_loopback  = true
      allowed_uris           = []
    }
    grant = {
      access_token_lifetime = var.access_oauth_token_lifetime
      session_duration      = var.access_oauth_grant_duration
    }
  }

  policies = [{
    name       = "Gridora authenticated users"
    decision   = "allow"
    precedence = 1
    include    = [{ everyone = {} }]
  }]

  lifecycle {
    prevent_destroy = true
  }
}

# These non-browser paths authenticate at the Gridora origin with node
# credentials, signed agent commands, or internal HMAC requests. The more
# specific Access applications prevent the hostname-wide human login policy
# from intercepting those protocols before the Worker can verify them. They do
# not advertise browser CORS: a browser must never be a transport for either
# machine or internal credentials.
resource "cloudflare_zero_trust_access_application" "origin_authenticated" {
  for_each = var.enable_resource_creation && var.enable_access_applications ? local.access_origin_authenticated_paths : {}

  account_id = var.account_id
  name       = "${local.prefix}-${replace(each.key, "_", "-")}-origin-authenticated"
  domain     = "${var.api_hostname}${each.value}"
  type       = "self_hosted"

  app_launcher_visible = false

  policies = [{
    name       = "Gridora origin authentication"
    decision   = "bypass"
    precedence = 1
    include    = [{ everyone = {} }]
  }]

  lifecycle {
    prevent_destroy = true
  }
}

# The public application can create a bounded sign-in, sign-up, or invitation
# intent. It cannot use credentialed browser CORS for any other API path.
resource "cloudflare_zero_trust_access_application" "public_auth_intent" {
  count      = var.enable_resource_creation && var.enable_access_applications ? 1 : 0
  account_id = var.account_id
  name       = "${local.prefix}-public-auth-intent"
  domain     = "${var.api_hostname}/v1/auth/intents"
  type       = "self_hosted"

  app_launcher_visible = false

  cors_headers = {
    allow_credentials = true
    allowed_headers = [
      "content-type",
      "x-correlation-id",
      "x-request-id",
    ]
    allowed_methods = ["POST"]
    allowed_origins = ["https://${var.public_app_hostname}"]
    max_age         = 600
  }

  policies = [{
    name       = "Gridora public authentication intent"
    decision   = "bypass"
    precedence = 1
    include    = [{ everyone = {} }]
  }]

  lifecycle {
    prevent_destroy = true
  }
}
