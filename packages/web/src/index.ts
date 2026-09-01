export { entity, isEntityBuilder, type EntityBuilder } from "./entity"
export { field, FIELD_TYPES, isFieldSpec, type FieldSpec, type FieldType } from "./field"
export {
  crud,
  count,
  CRUD_METHODS,
  defaultCrudPath,
  kebabCase,
  pluralize,
  type CrudInput,
  type CrudMethod,
  type CountInput,
} from "./crud"
export {
  lifecycle,
  transition,
  isLifecycleBuilder,
  type LifecycleInput,
  type TransitionInput,
  type TransitionSpec,
} from "./lifecycle"
export { page, api, type PageInput, type ApiInput } from "./routes"
export { default as webPackage } from "./spec-package"
