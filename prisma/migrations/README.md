# Prisma Migrations

This directory contains the database migration history managed by Prisma Migrate.

## Running migrations

```bash
# Apply all pending migrations (production)
npm run db:migrate:deploy

# Create and apply a new migration (development)
npm run db:migrate

# Generate the Prisma client after schema changes
npm run db:generate
```

## Migration history

| Migration | Description |
|-----------|-------------|
| `20260423000000_init` | Initial schema: User, ApiKey, RefreshToken, AuditEntry, Role enum |
