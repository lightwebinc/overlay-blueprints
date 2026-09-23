import knexLib, { type Knex } from 'knex'
import { KnexStorage, KnexStorageMigrations } from '@lightwebinc/overlay'

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
 * They come off the root export as a NAMESPACE (`export * as
 * KnexStorageMigrations`), which is why the array arrives on `.default` rather
 * than as the binding itself, and why the coalesce below exists.
 *
 * The deep path `@bsv/overlay/storage/knex/all-migrations.ts` does resolve:
 * the package's `exports` map carries `./storage/*` subpath patterns, checked
 * against the installed 2.3.1 rather than assumed. It is not used anyway,
 * because a subpath pattern is a wider promise than a package's root export
 * and the root export is the one the package's own README documents.
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
