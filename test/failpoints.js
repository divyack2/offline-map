// Test-only. The kill test loads this into the page and into the download worker.
// It can freeze the code at one chosen database call, so the browser can be killed at exactly that moment.
const CONTROL = 'http://localhost:9000';
const where = typeof document === 'undefined' ? 'worker' : 'page';

// A synchronous request: this thread does nothing else until the answer arrives.
function ask(path) {
  const request = new XMLHttpRequest();
  request.open('GET', CONTROL + path, false); // false = synchronous
  request.send();
  return request.responseText;
}

let armed = null; // e.g. { where: 'worker', method: 'get', store: 'chunks', skip: 5 }
try {
  armed = JSON.parse(ask('/__armed'));
} catch {
  // the test's server isn't running, so nothing is armed
}

if (armed && armed.where === where) {
  const original = IDBObjectStore.prototype[armed.method];
  let calls = 0;
  IDBObjectStore.prototype[armed.method] = function (...args) {
    if (this.name === armed.store && ++calls > armed.skip) {
      // The test never answers this request, so the thread stops here until the browser is killed.
      const key = Array.isArray(args[0]) ? args[0] : null; // [region id, chunk index] when the call names one chunk
      ask('/__freeze?key=' + encodeURIComponent(JSON.stringify(key)));
    }
    return original.apply(this, args);
  };
}

// In the worker, also tell the test whenever the fetcher retries, stops or fails, and why.
if (where === 'worker') {
  const post = self.postMessage.bind(self);
  self.postMessage = (message, ...rest) => {
    if (['retrying', 'stopped', 'failed'].includes(message?.status)) {
      fetch(`${CONTROL}/__note?text=${encodeURIComponent(`${message.status}: ${message.message}`)}`).catch(() => {});
    }
    return post(message, ...rest);
  };
}
