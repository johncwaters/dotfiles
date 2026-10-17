---
name: posthog-querying
description: 'Required reading before writing HogQL/SQL or calling execute-sql against PostHog. Use to search, find, or aggregate PostHog entities (insights, dashboards, cohorts, feature flags, experiments, surveys, hog flows, data warehouse, persons) and query analytics (trends, funnels, retention, lifecycle, paths, stickiness, web analytics, errors, logs, sessions, LLM traces). Uses the live PostHog MCP for schema discovery and HogQL guidance.'
---

# Querying data in PostHog

Use the live PostHog MCP `exec` tool. Discover command arguments and read its HogQL guidance before composing SQL; the server supplies current schemas, syntax, functions, and examples.

- `docs-search`: find relevant PostHog documentation and query guidance.
- `read-data-schema`: discover tables, columns, events, and properties for the request.
- `execute-sql`: search system tables for entities or run custom HogQL aggregations.
- `query`: run structured analytics queries when their insight schemas fit.

For entity discovery, find the ID with SQL, then use the entity's dedicated read command to retrieve its full representation. For analytics, adapt the MCP's examples to the requested metric and time range.
