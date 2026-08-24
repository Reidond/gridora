output "d1_database_id" {
  value       = try(cloudflare_d1_database.gridora[0].id, null)
  description = "D1 ID for the environment Wrangler config"
}

output "d1_database_name" {
  value       = local.prefix
  description = "Expected D1 name used by every rendered environment Worker config"
}

output "r2_bucket_names" {
  value       = local.r2_bucket_names
  description = "R2 bucket names for the environment Wrangler configs"
}

output "queue_names" {
  value       = merge(local.queue_names, local.dead_letter_queue_names)
  description = "Queue names for the environment Wrangler config"
}

output "worker_names" {
  value       = local.worker_names
  description = "Worker service names used by rendered service, Durable Object, and Workflow bindings"
}

output "environment_binding_contract" {
  value = {
    environment       = var.environment
    resource_prefix   = local.prefix
    d1_database_name  = local.prefix
    r2_bucket_names   = local.r2_bucket_names
    queue_names       = merge(local.queue_names, local.dead_letter_queue_names)
    worker_names      = local.worker_names
    zone_name         = var.zone_name
    public_app_origin = "https://${var.public_app_hostname}"
    console_origin    = "https://${var.console_hostname}"
    api_origin        = "https://${var.api_hostname}"
    dns_target        = var.dns_target_hostname
  }
  description = "Non-secret contract consumed by the environment renderer; IDs and Access audience remain protected deployment inputs."
}

output "access_application_audiences" {
  value = {
    console = try(cloudflare_zero_trust_access_application.console_api[0].aud, null)
    api     = try(cloudflare_zero_trust_access_application.console_api[0].aud, null)
  }
  description = "The shared multi-domain Access audience for console and API runtime configuration"
}
