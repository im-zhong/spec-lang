import { definePackage, defineNode, requires } from "@spec/package-sdk"
import { validateAuth } from "./validators"
import { authInspectors } from "./inspectors"

export default definePackage({
  name: "@spec/auth",
  version: "0.1.0",
  nodeKinds: [defineNode("auth"), defineNode("passwordStrategy"), defineNode("session")],
  capabilities: [requires("RelationalStore")],
  validators: [validateAuth],
  inspectors: authInspectors,
})
