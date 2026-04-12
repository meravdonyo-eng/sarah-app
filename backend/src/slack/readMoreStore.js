// Stores the "rest" of a structured response, awaiting a "Read more" button click.
// Uses the database so content survives server restarts.

import { dbStoreReadMore, dbPopReadMore } from '../services/db.js';

let counter = Math.floor(Math.random() * 100000);

export async function storeReadMore(content) {
  const id = String(++counter) + '_' + Date.now();
  await dbStoreReadMore(id, content);
  return id;
}

// Consume once — after retrieval the entry is removed
export async function popReadMore(id) {
  return await dbPopReadMore(id);
}
