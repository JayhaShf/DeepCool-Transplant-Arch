// Linux stub for electron-edge-js (Windows-only .NET bridge).
// The DeepCool main process requires this module; on Linux the .NET
// services it talks to (HWiNFO sensor bridge) are unavailable, so we
// provide a stub that fails gracefully when called.
function makeFunc() {
  return function (data, callback) {
    var err = new Error('[DeepCool-linux] electron-edge-js is not available on Linux (stubbed)');
    if (typeof callback === 'function') { callback(err, null); }
    else { return Promise.reject(err); }
  };
}
module.exports = {
  func: makeFunc,
  init: function () {},
  register: function () {},
  call: function () { throw new Error('[DeepCool-linux] edge call not available on Linux'); }
};
