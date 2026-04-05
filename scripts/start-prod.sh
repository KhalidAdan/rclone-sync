#!/bin/bash
set -e

echo "Running database migrations..."
npx drizzle-kit push

echo "Starting application..."
exec npm run start
