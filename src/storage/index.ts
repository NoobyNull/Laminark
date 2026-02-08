export { openDatabase } from './database.js';
export type { LaminarkDatabase } from './database.js';
export { runMigrations, MIGRATIONS } from './migrations.js';
export type { Migration } from './migrations.js';
export { ObservationRepository } from './observations.js';
export { SessionRepository } from './sessions.js';
export { SearchEngine } from './search.js';

// Re-export types that consumers need
export type {
  Observation,
  ObservationInsert,
  Session,
  SearchResult,
  DatabaseConfig,
} from '../shared/types.js';
export { getProjectHash, getDbPath, getDatabaseConfig, isDebugEnabled } from '../shared/config.js';
export { debug, debugTimed } from '../shared/debug.js';
