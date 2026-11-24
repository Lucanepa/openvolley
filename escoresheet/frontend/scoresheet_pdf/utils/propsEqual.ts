/**
 * Props equality for the sheet's memoised sections (React.memo): equal when
 * every prop is the same value, compared deeply for plain arrays and objects
 * (a new sheet model rebuilds equal arrays for the sets a live point did not
 * touch). Functions and other objects are compared by reference; a React
 * element by type, key and props (never its owner fiber).
 */
const isReactElement = (v: any): boolean => !!v && typeof v === 'object' && v.$$typeof !== undefined;

export function deepEqual(a: any, b: any, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (depth > 12) return false;
  if (isReactElement(a) || isReactElement(b)) {
    return isReactElement(a) && isReactElement(b) && a.type === b.type && a.key === b.key && deepEqual(a.props, b.props, depth + 1);
  }
  const arrA = Array.isArray(a);
  if (arrA !== Array.isArray(b)) return false;
  if (arrA) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], depth + 1)) return false;
    return true;
  }
  const protoA = Object.getPrototypeOf(a);
  if (protoA !== Object.getPrototypeOf(b) || (protoA !== Object.prototype && protoA !== null)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k], depth + 1)) return false;
  }
  return true;
}

/** React.memo comparator: the props are deeply equal. */
export const propsEqual = (prev: Readonly<Record<string, any>>, next: Readonly<Record<string, any>>): boolean => deepEqual(prev, next);
