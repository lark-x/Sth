import { DatabaseSync } from 'node:sqlite';
import { Operations, operationsDDL } from '../src/core/index.ts';
import { discoverOperations } from '../src/core/discovery.ts';
import { workspaceOperations, workspaceResourcePaths, workspaceSchemaVersion } from '../src/workspace.ts';

// Same definitions and registration checks as the HTTP service, without reading a user's database.
const [filter, ...extra] = process.argv.slice(2);
if (extra.length) throw new Error('Usage: node scripts/contract.ts [domain | operation.id | --full]');
const db = new DatabaseSync(':memory:');
try {
  db.exec(operationsDDL);
  const descriptors = new Operations(db, workspaceOperations).catalog().operations;
  const query = !filter ? { view: 'index' } : filter === '--full' ? {} :
    descriptors.some(item => item.id === filter) ? { operationId: filter } : { prefix: filter };
  const result = discoverOperations(descriptors, query);
  if (!result.operations.length) throw new Error('No operation or domain matches this filter.');
  console.log(JSON.stringify({ schemaVersion: workspaceSchemaVersion, resourcePaths: workspaceResourcePaths, ...result }, null, 2));
} finally { db.close(); }
