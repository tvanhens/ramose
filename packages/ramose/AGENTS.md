# Ramose Package

## Code Review Rules

### Pre-release compatibility

Ramose is pre-release, so breaking changes to existing APIs and formats are
acceptable. Prefer direct replacement over compatibility layers. Block only
when a change could strand durable user data or break a known consumer.

### Public API growth

Do not add public surface beyond the change's demonstrated need. Keep unproven
capabilities internal so they can be revised or removed without a breaking
change.
