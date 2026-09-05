import { defineNode, definePackage } from "@spec/package-sdk"
import { validateExamples } from "./validators"

export default definePackage({
  name: "@spec/test",
  version: "0.1.0",
  nodeKinds: [defineNode("example")],
  validators: [validateExamples],
})
