// Stores the "rest" of a structured response, awaiting a "Read more" button click.
// Each entry expires after 24 hours.

const store = new Map();
let counter = 0;

export function storeReadMore(content) {
  const id = String(++counter);
  store.set(id, content);
  setTimeout(() => store.delete(id), 24 * 60 * 60 * 1000);
  return id;
}

// Consume once — after retrieval the entry is removed
export function popReadMore(id) {
  const content = store.get(id) ?? null;
  if (content !== null) store.delete(id);
  return content;
}
