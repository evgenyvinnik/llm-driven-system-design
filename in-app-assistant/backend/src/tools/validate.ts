/**
 * Argument validation. Models sometimes invent arguments or send values that
 * don't match the schema. Instead of throwing, the orchestrator returns these
 * messages as the tool result, and the model usually fixes the call on the
 * next step.
 * @module tools/validate
 */
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'
import addFormatsModule from 'ajv-formats'

// ajv-formats is CommonJS; under NodeNext its default export arrives wrapped.
type AddFormats = (ajv: Ajv) => Ajv
const addFormats = ((addFormatsModule as unknown as { default?: AddFormats }).default ?? addFormatsModule) as unknown as AddFormats

const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false })
addFormats(ajv)

const cache = new Map<string, ValidateFunction>()

const FORMAT_HINTS: Record<string, string> = {
  date: 'a date like 2026-11-03',
  email: 'an email address',
}

function describe(error: ErrorObject): string {
  const field = error.instancePath.replace(/^\//, '').replace(/\//g, '.') || 'arguments'
  switch (error.keyword) {
    case 'required':
      return `missing required argument \`${(error.params as { missingProperty: string }).missingProperty}\``
    case 'additionalProperties':
      return `unknown argument \`${(error.params as { additionalProperty: string }).additionalProperty}\``
    case 'format': {
      const format = (error.params as { format: string }).format
      return `\`${field}\` must be ${FORMAT_HINTS[format] ?? `in ${format} format`}`
    }
    case 'enum':
      return `\`${field}\` must be one of ${(error.params as { allowedValues: unknown[] }).allowedValues.map((v) => JSON.stringify(v)).join(', ')}`
    case 'pattern':
      return `\`${field}\` has the wrong format (${error.message})`
    default:
      return `\`${field}\` ${error.message}`
  }
}

/** Returns a list of human-readable problems, or an empty list. Applies schema defaults to `args`. */
export function validateArgs(name: string, schema: Record<string, unknown>, args: unknown): string[] {
  let validate = cache.get(name)
  if (!validate) {
    validate = ajv.compile(schema)
    cache.set(name, validate)
  }
  if (validate(args)) return []
  return (validate.errors ?? []).map(describe)
}
