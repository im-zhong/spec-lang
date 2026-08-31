import { defineApp } from "@spec/core"
import { entity, field, crud } from "@spec/web"
import { auth, password } from "@spec/auth"
import { postgres } from "@spec/postgres"
import { fastapi } from "@spec/fastapi"

/**
 * Project 1 — Content CMS API.
 * Purpose: classic authenticated content backend.
 * Features: password auth, two-level refs (comment → post → user),
 * full CRUD everywhere, protected routes.
 */

const User = entity("User", {
  id: field.uuid(),
  email: field.email().unique(),
  name: field.string(),
})

const Post = entity("Post", {
  id: field.uuid(),
  title: field.string(),
  body: field.string().optional(),
  published: field.boolean().default(false),
  author: field.ref("User"),
})

const Comment = entity("Comment", {
  id: field.uuid(),
  body: field.string(),
  post: field.ref("Post"),
  author: field.ref("User"),
})

const MainAuth = auth({
  principal: User,
  strategy: password({ identity: User.fields.email }),
})

const Users = crud(User)
const Posts = crud(Post)
const Comments = crud(Comment)

const MainDB = postgres({ entities: [User, Post, Comment] })

const Server = fastapi({
  title: "Content API",
  services: [MainAuth, Users, Posts, Comments],
  resources: [MainDB],
})

export default defineApp({
  name: "ContentAPI",
  entities: [User, Post, Comment],
  services: [MainAuth, Users, Posts, Comments],
  resources: [MainDB, Server],
})
