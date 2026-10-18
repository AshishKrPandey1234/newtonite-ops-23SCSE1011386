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
