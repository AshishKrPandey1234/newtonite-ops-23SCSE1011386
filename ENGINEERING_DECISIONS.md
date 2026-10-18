# Engineering decisions

This log records decisions that are reflected in the current implementation.

## 2026-10-19 — Start with a dependency-free health API

- **Decision:** Use Node.js's built-in HTTP server for the initial health endpoint.
- **Alternatives considered:** Start with Express or implement the full API immediately.
- **Reason:** The repository was empty. A zero-dependency endpoint gives the project a runnable, checkable first commit before the application architecture grows.
- **Trade-off:** Routing and request validation are manual for now. As API features are added, we may adopt a framework if it improves maintainability.

## 2026-10-19 — Keep configuration out of version control

- **Decision:** Read the port from `PORT`, provide `.env.example`, and ignore local `.env` files and database files.
- **Reason:** Developers need a safe setup example without committing machine-specific settings or credentials.
- **Trade-off:** The initial API uses a shell-provided `PORT` and does not yet load `.env` automatically.

## 2026-10-19 — Use Node's built-in SQLite for the first persisted workflow

- **Decision:** Use `node:sqlite` with SQLite constraints and indexes, and require Node 24 or newer.
- **Alternatives considered:** Add an ORM/database driver dependency immediately or keep work items in JSON files.
- **Reason:** This keeps setup dependency-free while giving the workflow a relational schema, foreign keys, and SQL queries. The available runtime exposes the built-in module.
- **Trade-off:** Node currently labels the API experimental. SQLite is suitable for a local/demo app but is not the intended multi-instance production database.

## 2026-10-19 — Use opaque server-side sessions and optimistic versions

- **Decision:** Store a digest of a random session token in SQLite and return the token in an HttpOnly, SameSite cookie. Require a work item's current `version` in each update and update conditionally in SQL.
- **Alternatives considered:** Store credentials in local storage, persist bearer tokens directly, or accept last-write-wins updates.
- **Reason:** The cookie keeps the raw session token out of JavaScript, while the version check returns a conflict instead of silently overwriting a concurrent edit.
- **Trade-off:** The client must send cookies and reload after HTTP 409 conflicts. CSRF protections currently rely on SameSite cookies and same-origin deployment.

## 2026-10-19 — Encode workflow states and role policy in the API

- **Decision:** Restrict status/priority values with both application validation and SQLite CHECK constraints. Members can edit only work they created or are assigned; admins can edit all items and assign users.
- **Alternatives considered:** Allow arbitrary state strings or permit every signed-in user to change every record.
- **Reason:** A single transition map and role check make invalid workflow changes explicit and testable.
- **Trade-off:** There is no UI or endpoint to provision members yet; the initial admin is created from local environment variables.

## 2026-10-19 — Build the dashboard with React and Vite

- **Decision:** Use React 19 for the dashboard and Vite 7 for local development and production builds. Proxy `/api` requests from the Vite development server to the Node API.
- **Alternatives considered:** Build server-rendered HTML in the Node process or use a larger full-stack framework.
- **Reason:** A separate browser interface keeps the API usable independently and gives the dashboard a fast local feedback loop. The same-origin dev proxy lets the HttpOnly session cookie work without exposing it to JavaScript.
- **Trade-off:** Local development uses two processes, and a production host must serve the static `dist/` directory while forwarding `/api` to the Node service.

## 2026-10-19 — Make item creation transactional and retry-safe

- **Decision:** Require an `Idempotency-Key` on work item creation. In one `BEGIN IMMEDIATE` transaction, create the item and save the response under a user-scoped SHA-256 key digest.
- **Alternatives considered:** Let clients blindly retry or make the work item id itself the client-provided key.
- **Reason:** A retry with the same key and body can return the original result without duplicating the item. Reusing a key for different content returns a conflict.
- **Trade-off:** Idempotency records need cleanup, and this implementation retains them for up to 30 days after later create traffic. The transaction uses SQLite's synchronous API and is intended for this small single-process application.

## 2026-10-19 — Let admins provision member accounts

- **Decision:** Restrict member listing and creation to admins. New accounts are always `member`, passwords must be at least 12 characters, and only salted scrypt hashes are stored.
- **Alternatives considered:** Add public self-registration or allow the user endpoint to create additional admins.
- **Reason:** The app needs assignable teammates while keeping privileged roles under admin control.
- **Trade-off:** There is no password reset, invitation email, or role editing flow; admins share temporary passwords with new members out of band.
