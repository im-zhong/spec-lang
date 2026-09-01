import { defineApp } from "@spec/core"
import {
  entity, field, crud, lifecycle, transition,
  invariant, expr, effect,
} from "@spec/web"
import { auth, password } from "@spec/auth"
import { postgres } from "@spec/postgres"
import { fastapi } from "@spec/fastapi"

/**
 * Project 1 — Content CMS API.
 * Purpose: classic authenticated content backend.
 * Features: password auth, two-level refs (comment → post → user),
 * full CRUD everywhere, protected routes, and a row-local invariant
 * (behavior Phase 2): every post has a non-empty title.
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
  publishedAt: field.datetime().optional(),
  status: field.enum("draft", "published"),
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

// LINE — lifecycle: publishing sets the timestamp and emits an outbox
// event, all inside the transition's transaction.
const PostFlow = lifecycle(Post, {
  field: "status",
  initial: "draft",
  transitions: [
    transition("publish", {
      from: ["draft"],
      to: "published",
      effects: [
        effect.set("publishedAt", expr.request.time()),
        effect.emit("post.published", ["id", "title", "author"]),
      ],
    }),
  ],
})

// PLANE — row-local invariant: a post's title must never be empty.
const NoEmptyTitle = invariant("no-empty-title", {
  on: Post,
  check: expr.field("title").neq(expr.const("")),
})

const MainDB = postgres({ entities: [User, Post, Comment] })

const Server = fastapi({
  title: "Content API",
  services: [MainAuth, Users, Posts, Comments, PostFlow, NoEmptyTitle],
  resources: [MainDB],
})

export default defineApp({
  name: "ContentAPI",
  entities: [User, Post, Comment],
  services: [MainAuth, Users, Posts, Comments, PostFlow, NoEmptyTitle],
  resources: [MainDB, Server],
})
