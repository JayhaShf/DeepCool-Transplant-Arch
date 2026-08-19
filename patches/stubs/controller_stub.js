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
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (descriptor && !descriptor.configurable && 'value' in descriptor && !descriptor.writable) {
        return descriptor.value;
      }
      if (prop === 'then') {
        // thenable: await 桩值时立即完成。关键约束：resolve 的值绝不能是 p
        // （p 是 thenable，promise 解析会再次收养 → 无限微任务链挂起），
        // 因此 resolve(undefined)——与 Windows 桩返回 undefined 的行为一致。
        return function (onFulfilled) {
          if (typeof onFulfilled === 'function') onFulfilled();
          return 0;
        };
      }
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.iterator) {
        return function* () { /* empty iterable */ };
      }
      if (prop === Symbol.for('nodejs.util.inspect.custom')) return () => '[DeepCool linux stub]';
      return p;
    },
    set(target, prop, value) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (descriptor && !descriptor.configurable && 'value' in descriptor && !descriptor.writable) {
        return Object.is(descriptor.value, value);
      }
      return true;
    },
    has() { return true; },
    ownKeys(target) { return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop)
        || { configurable: true, enumerable: false, writable: true, value: p };
    }
  });
  return p;
}

module.exports = makeMagic();
