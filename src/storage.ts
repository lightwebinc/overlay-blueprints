import knexLib, { type Knex } from 'knex'
import { KnexStorage, KnexStorageMigrations } from '@bsv/overlay'

/**
 * Storage is the engine's own `KnexStorage` on MySQL. No storage backend is
 * written here and none is forked: the engine package ships both the store and
 * its migrations.
 */
export async function openStorage(knexUrl: string): Promise<{ db: Knex; storage: KnexStorage }> {
  // MySQL, and only MySQL. An earlier version also accepted a sqlite URL so the
  // host could be brought up without a database server, and that was a mistake
  // twice over: it made the exercised storage a different client from the
  // deployed one, and the driver it needed has no prebuilt binary for this Node
  // major, so every clean install compiled it. The engine's migrations have
  // client-specific branches; run them on the client that will run them.
  const db = knexLib({ client: 'mysql2', connection: knexUrl })
  await db.migrate.latest({ migrationSource: new InMemoryMigrationSource() })
  return { db, storage: new KnexStorage(db) }
}

/**
 * The engine's migrations ship as in-memory objects rather than files on disk,
 * so knex needs a source to run them through. There is no shorter way: knex's
 * default source reads a directory.
 *
 * They are reachable ONLY through the package root export. The deep path is
 * not listed in the package's `exports`, so importing it fails to resolve.
 */
class InMemoryMigrationSource implements Knex.MigrationSource<Knex.Migration> {
  private readonly list = (
    (KnexStorageMigrations as unknown as { default?: Knex.Migration[] }).default ??
    (KnexStorageMigrations as unknown as Knex.Migration[])
  )

  async getMigrations(): Promise<Knex.Migration[]> {
    return this.list
  }

  getMigrationName(migration: Knex.Migration): string {
    return `engine-${String(this.list.indexOf(migration)).padStart(4, '0')}`
  }

  async getMigration(migration: Knex.Migration): Promise<Knex.Migration> {
    return migration
  }
}

export { InMemoryMigrationSource }
