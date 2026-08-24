export const traversalInputs = [
  '../secret',
  '..%2fsecret',
  '%2e%2e/%2e%2e/etc/passwd',
  '/etc/shadow',
  'server/../../other-organization',
] as const

export const commandInjectionInputs = [
  '$(id)',
  '`id`',
  '; shutdown -h now',
  '&& curl https://example.invalid',
  '\n--config=/tmp/evil',
] as const

export const ssrfTargets = [
  'http://127.0.0.1/',
  'http://[::1]/',
  'http://169.254.169.254/latest/meta-data/',
  'http://10.0.0.1/',
  'http://192.168.1.1/',
  'file:///etc/passwd',
] as const

export const secretCanaries = [
  'provider-secret-canary',
  'tunnel-secret-canary',
  'rcon-secret-canary',
  'backup-key-canary',
] as const
