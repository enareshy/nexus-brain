-- 0002: emails are unique per tenant regardless of case (Pat@x.com == pat@x.com).
ALTER TABLE users DROP CONSTRAINT users_tenant_id_email_key;
CREATE UNIQUE INDEX users_tenant_email_lower_key ON users (tenant_id, lower(email));
