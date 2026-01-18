#!/bin/bash
# ClickHouse initialization script
# This runs on first container startup via docker-entrypoint-initdb.d

set -e

echo "Initializing ClickHouse schema..."

# Execute the SQL file with clickhouse-client
# Note: clickhouse-local is available in the container for running SQL
clickhouse-client --multiquery < /docker-entrypoint-initdb.d/schema.sql

echo "ClickHouse schema initialization complete!"
