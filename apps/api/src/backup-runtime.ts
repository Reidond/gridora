import { Layer } from 'effect'
import { BackupDataKeyPortLive, BackupKeyRandomLayer } from '@gridora/backup-key'
import { makeBackupKeyRepositoryD1Layer, type BackupKeyD1Database } from '@gridora/backup-key-d1'
import {
  BackupR2BucketLayer,
  BackupR2TransportLive,
  makeCloudflareBackupR2Bucket,
  type CloudflareR2BucketBindingShape,
} from '@gridora/backup-r2'
import { KekPort } from '@gridora/secret-envelope'

export interface ApiBackupRuntimeOptions {
  readonly database: BackupKeyD1Database
  readonly bucket: CloudflareR2BucketBindingShape
  readonly kek: Layer.Layer<KekPort>
}

/** Production Worker composition for D1-wrapped data keys and authenticated R2 transport. */
export const makeApiBackupTransportLayer = (options: ApiBackupRuntimeOptions) => {
  const dataKeys = BackupDataKeyPortLive.pipe(
    Layer.provide(makeBackupKeyRepositoryD1Layer(options.database)),
    Layer.provide(options.kek),
    Layer.provide(BackupKeyRandomLayer()),
  )
  return BackupR2TransportLive.pipe(
    Layer.provide(BackupR2BucketLayer(makeCloudflareBackupR2Bucket(options.bucket))),
    Layer.provide(dataKeys),
  )
}
