export interface Migration {
  readonly id: number
  readonly name: string
  readonly file: string
}

export const migrations: ReadonlyArray<Migration> = [
  { id: 1, name: 'identity_organizations', file: '0001_identity_organizations.sql' },
  { id: 2, name: 'operations_outbox', file: '0002_operations_outbox.sql' },
  { id: 3, name: 'mvp_inventory', file: '0003_mvp_inventory.sql' },
  { id: 4, name: 'provider_account_credentials', file: '0004_provider_account_credentials.sql' },
  { id: 5, name: 'registration_policy_audit', file: '0005_registration_policy_audit.sql' },
  { id: 6, name: 'lifecycle_reservations', file: '0006_lifecycle_reservations.sql' },
  { id: 7, name: 'audit_export_outbox', file: '0007_audit_export_outbox.sql' },
  { id: 8, name: 'tunnel_credential_delivery', file: '0008_tunnel_credential_delivery.sql' },
  { id: 9, name: 'orphan_findings', file: '0009_orphan_findings.sql' },
  { id: 10, name: 'backup_wrapped_keys', file: '0010_backup_wrapped_keys.sql' },
  { id: 11, name: 'provider_account_lifecycle', file: '0011_provider_account_lifecycle.sql' },
  { id: 12, name: 'node_provision_acceptance', file: '0012_node_provision_acceptance.sql' },
  { id: 13, name: 'server_plan', file: '0013_server_plan.sql' },
  { id: 14, name: 'agent_observation_ingestion', file: '0014_agent_observation_ingestion.sql' },
  {
    id: 15,
    name: 'node_provision_execution_lease',
    file: '0015_node_provision_execution_lease.sql',
  },
  { id: 16, name: 'platform_provider_control', file: '0016_platform_provider_control.sql' },
  {
    id: 17,
    name: 'game_server_lifecycle_execution',
    file: '0017_game_server_lifecycle_execution.sql',
  },
  { id: 18, name: 'backup_orchestration', file: '0018_backup_orchestration.sql' },
  {
    id: 19,
    name: 'destructive_lifecycle_termination',
    file: '0019_destructive_lifecycle_termination.sql',
  },
  { id: 20, name: 'logs_health_aggregates', file: '0020_logs_health_aggregates.sql' },
  {
    id: 21,
    name: 'scheduled_orphan_reconciliation',
    file: '0021_scheduled_orphan_reconciliation.sql',
  },
  {
    id: 22,
    name: 'automation_identity_credentials',
    file: '0022_automation_identity_credentials.sql',
  },
  { id: 23, name: 'node_image_lifecycle', file: '0023_node_image_lifecycle.sql' },
  { id: 24, name: 'node_runtime_lifecycle', file: '0024_node_runtime_lifecycle.sql' },
  {
    id: 25,
    name: 'scheduled_policy_reconciliation',
    file: '0025_scheduled_policy_reconciliation.sql',
  },
  {
    id: 26,
    name: 'organization_membership_leave',
    file: '0026_organization_membership_leave.sql',
  },
  {
    id: 27,
    name: 'game_command_envelope',
    file: '0027_game_command_envelope.sql',
  },
  {
    id: 28,
    name: 'audit_envelope_v1',
    file: '0028_audit_envelope_v1.sql',
  },
  {
    id: 29,
    name: 'telemetry_ingestion_receipts',
    file: '0029_telemetry_ingestion_receipts.sql',
  },
  {
    id: 30,
    name: 'scheduled_backups',
    file: '0030_scheduled_backups.sql',
  },
  {
    id: 31,
    name: 'core_mutation_operations',
    file: '0031_core_mutation_operations.sql',
  },
  {
    id: 32,
    name: 'policy_identifier_contract',
    file: '0032_policy_identifier_contract.sql',
  },
  {
    id: 33,
    name: 'organization_deletion_audit_provenance',
    file: '0033_organization_deletion_audit_provenance.sql',
  },
  {
    id: 34,
    name: 'game_audit_terminal_operations',
    file: '0034_game_audit_terminal_operations.sql',
  },
  {
    id: 35,
    name: 'cancellation_audit_provenance',
    file: '0035_cancellation_audit_provenance.sql',
  },
  {
    id: 36,
    name: 'game_server_move_execution',
    file: '0036_game_server_move_execution.sql',
  },
  {
    id: 37,
    name: 'telemetry_stream_epochs_and_reconciliation',
    file: '0037_telemetry_stream_epochs_and_reconciliation.sql',
  },
  {
    id: 38,
    name: 'identity_preferences',
    file: '0038_identity_preferences.sql',
  },
  {
    id: 39,
    name: 'game_lifecycle_completion_audit',
    file: '0039_game_lifecycle_completion_audit.sql',
  },
  {
    id: 40,
    name: 'node_provision_audit_provenance',
    file: '0040_node_provision_audit_provenance.sql',
  },
  {
    id: 41,
    name: 'node_lifecycle_audit_provenance',
    file: '0041_node_lifecycle_audit_provenance.sql',
  },
  {
    id: 42,
    name: 'server_provision_plan_orchestration',
    file: '0042_server_provision_plan_orchestration.sql',
  },
  {
    id: 43,
    name: 'operation_detail_projection',
    file: '0043_operation_detail_projection.sql',
  },
  {
    id: 44,
    name: 'node_lifecycle_provider_binding_snapshot',
    file: '0044_node_lifecycle_provider_binding_snapshot.sql',
  },
  {
    id: 45,
    name: 'telemetry_archive_cleanup_lease',
    file: '0045_telemetry_archive_cleanup_lease.sql',
  },
  {
    id: 46,
    name: 'telemetry_archive_generation_fence',
    file: '0046_telemetry_archive_generation_fence.sql',
  },
  {
    id: 47,
    name: 'agent_machine_audit_receipts',
    file: '0047_agent_machine_audit_receipts.sql',
  },
  {
    id: 48,
    name: 'backup_restore_saga_and_completion_audit',
    file: '0048_backup_restore_saga_and_completion_audit.sql',
  },
  {
    id: 49,
    name: 'telemetry_epoch_reservations_and_live_log_authorization',
    file: '0049_telemetry_epoch_reservations_and_live_log_authorization.sql',
  },
  {
    id: 50,
    name: 'provider_account_operation_audit_provenance',
    file: '0050_provider_account_operation_audit_provenance.sql',
  },
  {
    id: 51,
    name: 'game_lifecycle_terminal_move_dns_repair',
    file: '0051_game_lifecycle_terminal_move_dns_repair.sql',
  },
  {
    id: 52,
    name: 'backup_physical_retention_deletion',
    file: '0052_backup_physical_retention_deletion.sql',
  },
  {
    id: 53,
    name: 'platform_provider_operation_audit_provenance',
    file: '0053_platform_provider_operation_audit_provenance.sql',
  },
  {
    id: 54,
    name: 'backup_abandoned_physical_cleanup',
    file: '0054_backup_abandoned_physical_cleanup.sql',
  },
  {
    id: 55,
    name: 'telemetry_archive_upload_watch_fence',
    file: '0055_telemetry_archive_upload_watch_fence.sql',
  },
  {
    id: 56,
    name: 'game_move_target_staging_evidence',
    file: '0056_game_move_target_staging_evidence.sql',
  },
  {
    id: 57,
    name: 'backup_upload_generation_lease',
    file: '0057_backup_upload_generation_lease.sql',
  },
  {
    id: 58,
    name: 'node_lifecycle_rebuild_bootstrap_provenance',
    file: '0058_node_lifecycle_rebuild_bootstrap_provenance.sql',
  },
  {
    id: 59,
    name: 'game_server_declarative_desired_specs',
    file: '0059_game_server_declarative_desired_specs.sql',
  },
  {
    id: 60,
    name: 'orphan_symmetry_matrix',
    file: '0060_orphan_symmetry_matrix.sql',
  },
  {
    id: 61,
    name: 'game_mod_metadata_acceptance',
    file: '0061_game_mod_metadata_acceptance.sql',
  },
  {
    id: 62,
    name: 'game_failed_node_forced_cleanup',
    file: '0062_game_failed_node_forced_cleanup.sql',
  },
  {
    id: 63,
    name: 'game_server_drafts_and_schedules',
    file: '0063_game_server_drafts_and_schedules.sql',
  },
]
