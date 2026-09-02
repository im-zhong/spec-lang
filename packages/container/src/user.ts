const OCI_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/
const OCI_ID = /^(0|[1-9][0-9]*)$/
const MAX_OCI_ID = 4_294_967_295n

function validPrincipal(value: string, allowZero: boolean): boolean {
  if (OCI_NAME.test(value)) return value.toLowerCase() !== "root"
  if (!OCI_ID.test(value)) return false
  const id = BigInt(value)
  return id <= MAX_OCI_ID && (allowZero || id !== 0n)
}

/** Accept only an OCI user[:group] that cannot resolve directly to root. */
export function isSafeNonRootOciUser(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false
  const parts = value.split(":")
  if (parts.length > 2 || parts.some((part) => part.length === 0)) return false
  // Root by name and UID 0 are forbidden. Reject root/GID 0 too: either grants
  // avoidable access to files owned by the privileged account/group.
  return validPrincipal(parts[0], false) && (parts[1] === undefined || validPrincipal(parts[1], false))
}
