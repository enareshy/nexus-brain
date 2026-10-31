-- DEV ONLY: runs once when the local Postgres volume is first created.
-- Creates the application login role with a local test password (matches .env.example).
-- Production roles and passwords come from the secret manager, never from this file.
CREATE ROLE brain_app LOGIN PASSWORD 'brain_app';
