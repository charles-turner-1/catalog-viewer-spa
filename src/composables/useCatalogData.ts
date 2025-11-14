import { ref, onMounted } from 'vue'
import * as duckdb from '@duckdb/duckdb-wasm'
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'

/**
 * A single row from the catalog parquet file after normalization.
 *
 * All list-like fields are normalized to arrays of strings for easier consumption
 * in the UI. Fields that are missing or null are represented as empty arrays or
 * empty strings as appropriate.
 */
interface CatalogRow {
  /** Display name or identifier for the catalog entry. */
  name: string
  /** One or more model identifiers associated with this entry. */
  model: string[]
  /** Human readable description of the entry. */
  description: string
  /** One or more realms where this entry is applicable. */
  realm: string[]
  /** One or more frequency tags associated with the entry. */
  frequency: string[]
  /** One or more variable names this entry references. */
  variable: string[]
}

/**
 * URL (relative to the site root) where the parquet file containing the
 * metacatalog can be downloaded. Can be replaced with a different endpoint
 * or path in deployments.
 */
const PARQUET_URL = '/api/parquet/metacatalog.parquet'

// DuckDB bundle configuration
/**
 * DuckDB wasm bundles used by the client. duckdb.selectBundle will pick the
 * best available bundle for the current environment.
 */
const DUCKDB_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: duckdb_wasm,
    mainWorker: mvp_worker,
  },
  eh: {
    mainModule: duckdb_wasm_eh,
    mainWorker: eh_worker,
  },
}

/**
 * SQL used to read and normalize the metacatalog parquet file. Extracted so
 * it can be referenced from both async and promise-chain styles.
 */
const METACAT_PARQUET_QUERY = `
  SELECT 
    name,
    CASE 
      WHEN typeof(model) LIKE '%[]%' THEN model::VARCHAR[]
      WHEN model IS NOT NULL THEN [model::VARCHAR]
      ELSE []::VARCHAR[]
    END as model,
    description,
    CASE 
      WHEN typeof(realm) LIKE '%[]%' THEN realm::VARCHAR[]
      WHEN realm IS NOT NULL THEN [realm::VARCHAR]
      ELSE []::VARCHAR[]
    END as realm,
    CASE 
      WHEN typeof(frequency) LIKE '%[]%' THEN frequency::VARCHAR[]
      WHEN frequency IS NOT NULL THEN [frequency::VARCHAR]
      ELSE []::VARCHAR[]
    END as frequency,
    CASE 
      WHEN typeof(variable) LIKE '%[]%' THEN variable::VARCHAR[]
      WHEN variable IS NOT NULL THEN [variable::VARCHAR]
      ELSE []::VARCHAR[]
    END as variable
  FROM read_parquet('metacatalog.parquet')
  LIMIT 10
`

/**
 * Download the parquet file from the configured endpoint and return it as a
 * Uint8Array.
 *
 * @throws {Error} when the HTTP request fails or returns a non-OK status.
 */
function fetchParquetFile(): Promise<Uint8Array> {
  return fetch(PARQUET_URL)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch parquet file: ${response.status}`)
      }
      return response.arrayBuffer()
    })
    .then((arrayBuffer) => new Uint8Array(arrayBuffer))
}

/**
 * Initialize a DuckDB WASM instance and return the database and connection
 * objects.
 *
 * This uses duckdb.selectBundle to choose the appropriate wasm bundle for the
 * current environment, spawns the worker, and instantiates the AsyncDuckDB
 * instance.
 */
async function initializeDuckDB() {
  const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES)
  const worker = new Worker(bundle.mainWorker!)
  const logger = new duckdb.ConsoleLogger()
  const db = new duckdb.AsyncDuckDB(logger, worker)

  await db.instantiate(bundle.mainModule)
  const conn = await db.connect()

  return { db, conn }
}

/**
 * Convert a value coming from DuckDB into an array of strings.
 * Handles null/undefined, native arrays, JSON-encoded strings, and
 * single scalar values.
 */
function processListField(value: any): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined).map(String)
  if (typeof value === 'string') {
    // Handle potential JSON strings or comma-separated values
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)]
    } catch {
      // If not JSON, treat as single value
      return [value]
    }
  }
  return [String(value)]
}

/**
 * Query the registered parquet buffer and return normalized catalog rows.
 *
 * This function registers the provided parquet Uint8Array with the DuckDB
 * instance under a fixed filename and runs a SQL query that attempts to
 * normalize various possible encodings of list-like fields into VARCHAR[]
 * values. The returned rows are then converted into the {@link CatalogRow}
 * shape expected by the UI.
 *
 * @param db - The AsyncDuckDB instance used for registering the buffer.
 * @param conn - A live DuckDB connection used to run queries.
 * @param uint8Array - Contents of the parquet file as a Uint8Array.
 */
async function queryParquetData(db: duckdb.AsyncDuckDB, conn: duckdb.AsyncDuckDBConnection, uint8Array: Uint8Array): Promise<CatalogRow[]> {
  // Register the parquet file and run the query using a promise chain. We
  // keep the registration and the query sequential since the query depends
  // on the file being registered first.
  return db
    .registerFileBuffer('metacatalog.parquet', uint8Array)
    .then(() => conn.query(METACAT_PARQUET_QUERY))
    .then((queryResult: any) =>
      // Transform to our interface with proper array handling
      queryResult.toArray().map((row: any) => ({
        name: row.name || '',
        model: processListField(row.model),
        description: row.description || '',
        realm: processListField(row.realm),
        frequency: processListField(row.frequency),
        variable: processListField(row.variable),
      }))
    )
}

/**
 * Vue composable that loads and exposes catalog data from a parquet file.
 *
 * Returned shape:
 * - data: Ref<CatalogRow[]> - normalized catalog rows
 * - loading: Ref<boolean> - whether a load is in progress
 * - error: Ref<string | null> - human readable error message, if any
 * - refetch: () => Promise<void> - manual trigger to re-download and re-query
 */
export function useCatalogData() {
  const data = ref<CatalogRow[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  const fetchCatalogData = async () => {
    loading.value = true
    error.value = null

    let db: duckdb.AsyncDuckDB | null = null
    let conn: duckdb.AsyncDuckDBConnection | null = null

    try {
      console.log('Fetching catalog data...')

      // Fetch parquet file and initialize DuckDB concurrently
      const [uint8Array, dbConnection] = await Promise.all([
        fetchParquetFile(),
        initializeDuckDB()
      ])

      console.log(`Downloaded ${uint8Array.length} bytes`)
      db = dbConnection.db
      conn = dbConnection.conn

      // Query and transform data
      data.value = await queryParquetData(db, conn, uint8Array)
      console.log(`Loaded ${data.value.length} catalog entries`)

    } catch (err) {
      console.error('Error loading catalog data:', err)
      error.value = err instanceof Error ? err.message : 'An unknown error occurred'
    } finally {
      // Cleanup
      if (conn) await conn.close()
      if (db) await db.terminate()
      loading.value = false
    }
  }

  onMounted(() => {
    fetchCatalogData()
  })

  return {
    data,
    loading,
    error,
    refetch: fetchCatalogData
  }
}