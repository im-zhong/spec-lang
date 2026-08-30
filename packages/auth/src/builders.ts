/**
 * Auth builders.
 *
 *   auth({ principal: User, strategy: password({ identity: User.fields.email }) })
 *
 * Builders never throw on semantically-invalid input — invalid shapes are
 * stored as-is so the auth validator can emit structured diagnostics with
 * the user's source locations.
 */
import {
  isFieldRef,
  isNodeBuilder,
  nodeBuilder,
  serializeValue,
  toReference,
  type SpecNodeBuilder,
} from "@spec/core"

export interface PasswordStrategyInput {
  identity?: unknown
  [key: string]: unknown
}

export function password(input: PasswordStrategyInput): SpecNodeBuilder {
  const attributes: Record<string, unknown> = {}
  if (input && "identity" in input) {
    attributes.identity = serializeValue(input.identity)
  } else {
    attributes.identity = undefined
  }
  return nodeBuilder("@spec/auth", "passwordStrategy", undefined, attributes)
}

export interface AuthInput {
  principal?: unknown
  strategy?: unknown
  [key: string]: unknown
}

/**
 * Auth requires a RelationalStore capability (satisfied e.g. by the
 * @spec/postgres resource). The link pass in the compiler core checks
 * requirements against providers generically.
 */
export const AUTH_REQUIRES = ["RelationalStore"]

export function auth(input: AuthInput): SpecNodeBuilder {
  const attributes: Record<string, unknown> = {
    requires: [...AUTH_REQUIRES],
  }
  if (input && "principal" in input) {
    const principal = input.principal
    if (isNodeBuilder(principal)) {
      attributes.principal = toReference(principal)
    } else {
      // invalid principal — keep raw value for the validator to diagnose
      attributes.principal = serializeValue(principal)
    }
  } else {
    attributes.principal = undefined
  }

  const children: SpecNodeBuilder[] = []
  if (input && "strategy" in input && input.strategy !== undefined) {
    const strategy = input.strategy
    if (isNodeBuilder(strategy)) {
      children.push(strategy)
    } else {
      attributes.strategy = serializeValue(strategy)
    }
  }
  return nodeBuilder("@spec/auth", "auth", undefined, attributes, children)
}
