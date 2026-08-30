# common/

Cross-cutting building blocks shared across domain modules:

- `guards/` — `SupabaseJwtGuard`, `RolesGuard`
- `decorators/` — `@CurrentUser()`, `@Roles()`, `@Public()`
- `filters/` — global exception filter (uniform error envelope)
- `interceptors/` — logging, request-id
- `dto/` — shared DTOs / pagination

Empty for now — populated as modules are implemented. Nothing here may own
transaction state or money logic; that lives in `modules/`.
