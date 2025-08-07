# Docker Setup for BerryDotMe

This project includes a Docker Compose configuration for local development with PostgreSQL and Redis.

## Services

- **PostgreSQL 15**: Database server on port 5432
- **Redis 7**: Cache and session store on port 6379

## Quick Start

1. Start the services:
```bash
docker-compose up -d
```

2. Stop the services:
```bash
docker-compose down
```

3. View logs:
```bash
docker-compose logs -f
```

## Environment Variables

Create a `.env` file in your project root or frontend directory with these variables:

```env
# Database Configuration
DATABASE_URL="postgresql://berrydotme_user:berrydotme_password@localhost:5432/berrydotme"

# Redis Configuration
REDIS_URL="redis://localhost:6379"

# Next.js Configuration
NEXTAUTH_SECRET="your-nextauth-secret-here"
NEXTAUTH_URL="http://localhost:3000"

# Development Configuration
NODE_ENV=development
```

## Default Credentials

- **PostgreSQL:**
  - Database: `berry`
  - Username: `berry_user`
  - Password: `berry_password`
  - Port: `5432`

- **Redis:**
  - No authentication required
  - Port: `6379`

## Data Persistence

Both PostgreSQL and Redis data are persisted in Docker volumes:
- `postgres_data`: PostgreSQL data
- `redis_data`: Redis data

## Health Checks

Both services include health checks to ensure they're running properly before your application connects to them.

## Initialization Scripts

You can add PostgreSQL initialization scripts in the `./init-scripts/` directory. These will be executed when the database is first created. 