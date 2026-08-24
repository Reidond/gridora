import YAML from 'yaml'

export type OutputFormat = 'table' | 'json' | 'yaml'

const scalar = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  if (typeof value === 'symbol') return value.description ?? ''
  if (typeof value === 'function') return value.name
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString()
  return ''
}

export const renderOutput = (value: unknown, format: OutputFormat): string => {
  if (format === 'json') return `${JSON.stringify(value, null, 2)}\n`
  if (format === 'yaml') return YAML.stringify(value)
  const rows = Array.isArray(value) ? value : [value]
  if (rows.length === 0) return 'No results.\n'
  if (!rows.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row)))
    return `${scalar(value)}\n`
  const objects = rows as ReadonlyArray<Readonly<Record<string, unknown>>>
  const columns = [...new Set(objects.flatMap((row) => Object.keys(row)))]
  const widths = columns.map((column) =>
    Math.max(column.length, ...objects.map((row) => scalar(row[column]).length)),
  )
  const line = (row: Readonly<Record<string, unknown>>) =>
    columns
      .map((column, index) => scalar(row[column]).padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd()
  return `${line(Object.fromEntries(columns.map((column) => [column, column.toUpperCase()])))}\n${objects.map(line).join('\n')}\n`
}
