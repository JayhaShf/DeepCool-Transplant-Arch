'use strict';
// Linux stub for Windows-only Rust napi controller modules (DeepCool LCD/USB).
// The real modules are PE32 DLLs using rusb + napi-rs. On Linux they cannot be
// loaded, so we substitute a permissive Proxy object: every property access
// returns a callable, every call returns a benign value, `new` works,
// iteration works, and the value is thenable (await resolves to itself) so
// promise-based call sites do not crash. Device enumeration returns nothing
// and drawing to the LCD screen will not work, but the app UI can boot.

function makeMagic() {
  const fn = function MagicStub() {};
  const p = new Proxy(fn, {
    apply(target, thisArg, args) { return p; },
    construct(target, args) { return p; },
    get(target, prop, receiver) {
      if (prop === 'then') {
        // thenable: await / .then() resolves to the stub itself
        return function (onFulfilled) {
          if (typeof onFulfilled === 'function') return Promise.resolve(p).then(onFulfilled);
          return Promise.resolve(p);
        };
      }
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.iterator) {
        return function* () { /* empty iterable */ };
      }
      if (prop === Symbol.for('nodejs.util.inspect.custom')) return () => '[DeepCool linux stub]';
      return p;
    },
    set() { return true; },
    has() { return true; },
    ownKeys() { return []; },
    getOwnPropertyDescriptor() { return { configurable: true, enumerable: false, writable: true, value: p }; }
  });
  return p;
}

module.exports = makeMagic();
