#!/bin/sh
# Container entrypoint: bring the database schema up to date, optionally
# load demo data into an EMPTY database, then start the server.
set -e
npx prisma migrate deploy
if [ "$DEMO_SEED" = "true" ]; then
  npx tsx prisma/seed.ts --if-empty
fi
exec node dist/server.js
