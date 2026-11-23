type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function ownValue(object: object, key: string | number): unknown {
  const property = Object.getOwnPropertyDescriptor(object, key);
  if (!property || !('value' in property)) {
    throw new TypeError('Expected a JSON data property.');
  }
  return property.value;
}

/** Snapshot JSON data without calling getters or toJSON methods. */
export function serializeJson(value: unknown, canonical = false): string {
  const ancestors = new Set<object>();

  function visit(item: unknown): JsonValue {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || ancestors.has(item)) {
      throw new TypeError('Expected acyclic JSON data.');
    }

    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        return Array.from({ length: item.length }, (_, index) => visit(ownValue(item, index)));
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Expected a plain JSON object.');
      }

      const keys = Object.keys(item);
      if (canonical) keys.sort();
      return Object.fromEntries(keys.map(key => [key, visit(ownValue(item, key))]));
    } finally {
      ancestors.delete(item);
    }
  }

  return JSON.stringify(visit(value));
}
