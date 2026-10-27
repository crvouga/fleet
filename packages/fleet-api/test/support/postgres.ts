/**
 * The throwaway Postgres the database tests run against: a cluster built with
 * initdb and pg_ctl in $TMPDIR, `create schema fleet`, then schema.hcl applied
 * by the real Atlas CLI scoped with `?search_path=fleet`, exactly as OpenTofu
 * does in production. Missing tools skip locally and fail when CI is set.
 */
export { startCluster, type Cluster, type ClusterOptions } from './cluster';
export { databaseAvailable, useDatabase, type TestDatabase } from './database';
export { findTooling, type Tooling } from './tooling';
