// Unit tests for the watcher.
//
// We fake the k8s api watch and collection endpoints so that the tests are
// runable without k8s environment and let us test corner cases which would
// normally be impossible.

const assert = require('chai').assert;
const Watcher = require('./watcher').Watcher;
const Readable = require('stream').Readable;

// Create fake k8s object. Example of true k8s object follows:
//
//  "object": {
//    "apiVersion": "csi.storage.k8s.io/v1alpha1",
//    "kind": "CSINodeInfo",
//    "metadata": {
//      "creationTimestamp": "2019-02-15T18:23:53Z",
//      "generation": 13,
//      "name": "node1",
//      "ownerReferences": [
//        {
//          "apiVersion": "v1",
//          "kind": "Node",
//          "name": "node1",
//          "uid": "c696b8e5-fd8c-11e8-a41c-589cfc0d76a7"
//        }
//      ],
//      "resourceVersion": "627981",
//      "selfLink": "/apis/csi.storage.k8s.io/v1alpha1/csinodeinfos/node1",
//      "uid": "d99f06a9-314e-11e9-b086-589cfc0d76a7"
//    },
//    "spec": {
//        ...
//    },
//    "status": {
//        ...
//    }
//  }
function createObject(name, generation, val) {
  return {
    kind: 'mykind',
    apiVersion: 'my.group.io/v1alpha1',
    metadata: { name, generation },
    spec: { val },
  };
}

// Simple filter which produces objects {name, val} from the objects
// created by the createObject() above and only objects with val > 100
// pass through the filter.
function objectFilter(k8sObject) {
  if (k8sObject.kind != 'mykind') {
    return null;
  }
  if (k8sObject.spec.val > 100) {
    return {
      name: k8sObject.metadata.name,
      val: k8sObject.spec.val,
    };
  } else {
    return null;
  }
}

// Mock for GET k8s API request returning a collection of k8s objects which
// were previously stored to the mock using add() method.
class GetMock {
  constructor(delay) {
    this.delay = delay;
    this.objects = {};
  }

  add(obj) {
    this.objects[obj.metadata.name] = obj;
  }

  remove(name) {
    delete this.objects[name];
  }

  reset() {
    this.objects = {};
  }

  get() {
    var self = this;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve({
          statusCode: 200,
          body: { items: Object.values(self.objects) },
        });
      }, self.delay || 0);
    });
  }
}

// Mock representing k8s watch stream.
// You can feed arbitrary strings to it and it will pass them to a consumer.
// Example of k8s watch stream event follows:
//
// {
//  "type": "ADDED",
//  "object": {
//     ... (object as shown in GetMock example above)
//  }
//}
//
// NOTE: The event objects must be each on its own line. That's how k8s does
// it and event parser otherwise breaks!
class StreamMock extends Readable {
  constructor() {
    super({ autoDestroy: true });
    this.feeds = [];
    this.wantMore = false;
  }

  _read(size) {
    while (true) {
      let chunk = this.feeds.shift();
      if (chunk === undefined) {
        this.wantMore = true;
        break;
      }
      this.push(chunk);
    }
  }

  feedRaw(str) {
    this.feeds.push(str);
    if (this.wantMore) {
      this.wantMore = false;
      this._read();
    }
  }

  feed(type, object) {
    this.feedRaw(JSON.stringify({ type, object }) + '\n');
  }

  end() {
    this.feedRaw(null);
  }

  getStream() {
    return this;
  }
}

// This is for test cases where we need to test watch stream disconnection.
// In that case, the watcher will create a new instance of watch stream
// (by calling getStream) and we need to keep track of latest created stream
// in order to be able to feed data to it etc.
class StreamMockTracker {
  constructor() {
    this.current = null;
  }

  // create a new stream (mimics nodejs k8s client api)
  getStream() {
    let s = new StreamMock();
    this.current = s;
    return s;
  }

  // get the most recently created underlaying stream
  latest() {
    return this.current;
  }
}

module.exports = function() {
  // Basic watcher operations grouped in describe to avoid repeating watcher
  // initialization & tear down for each test case.
  describe('watch events', () => {
    var getMock = new GetMock();
    var streamMock = new StreamMock();
    var watcher;
    var newList = [];
    var modList = [];
    var delList = [];

    before(() => {
      watcher = new Watcher('test', getMock, streamMock, objectFilter);
      watcher.on('new', obj => newList.push(obj));
      watcher.on('mod', obj => modList.push(obj));
      watcher.on('del', obj => delList.push(obj));

      getMock.add(createObject('valid-object', 1, 123));
      getMock.add(createObject('invalid-object', 1, 99));
    });

    after(() => {
      watcher.stop();
      streamMock.end();
    });

    it('should init cache only with objects which pass through the filter', async () => {
      await watcher.start();

      assert.lengthOf(modList, 0);
      assert.lengthOf(delList, 0);
      assert.lengthOf(newList, 1);
      assert.equal(newList[0].name, 'valid-object');
      assert.equal(newList[0].val, 123);

      let lst = watcher.list();
      assert.lengthOf(lst, 1);
      assert.hasAllKeys(lst[0], ['name', 'val']);
      assert.equal(lst[0].name, 'valid-object');
      assert.equal(lst[0].val, 123);

      let rawObj = watcher.getRaw('valid-object');
      assert.deepEqual(rawObj, createObject('valid-object', 1, 123));
    });

    it('should add object to the cache only if it passes through the filter', done => {
      // invalid object should not be added
      streamMock.feed('ADDED', createObject('add-invalid-object', 1, 90));
      // valid object should be added
      streamMock.feed('ADDED', createObject('evented-object', 1, 155));

      function check() {
        assert.lengthOf(modList, 0);
        assert.lengthOf(delList, 0);
        assert.lengthOf(newList, 2);
        assert.equal(newList[1].name, 'evented-object');
        assert.equal(newList[1].val, 155);
        done();
      }

      // Use a trick to check 'new' event regardless if it has already arrived
      // or will arrive yet.
      if (newList.length > 1) {
        check();
      } else {
        watcher.once('new', () => process.nextTick(check));
      }
    });

    it('should modify object in the cache if it passes through the filter', done => {
      // new object should be added and new event emitted (not the mod event)
      streamMock.feed('MODIFIED', createObject('new-object', 1, 160));
      // object with old generation number should be ignored
      streamMock.feed('MODIFIED', createObject('evented-object', 1, 155));
      // object should be modified
      streamMock.feed('MODIFIED', createObject('evented-object', 2, 156));
      // object should be modified (without gen number)
      streamMock.feed(
        'MODIFIED',
        createObject('evented-object', undefined, 157)
      );

      function check() {
        assert.lengthOf(delList, 0);
        assert.lengthOf(modList, 2);
        assert.equal(modList[0].name, 'evented-object');
        assert.equal(modList[0].val, 156);
        assert.equal(modList[1].name, 'evented-object');
        assert.equal(modList[1].val, 157);
        assert.lengthOf(newList, 3);
        assert.equal(newList[2].name, 'new-object');
        assert.equal(newList[2].val, 160);
        done();
      }

      if (modList.length > 0) {
        check();
      } else {
        watcher.once('mod', () => process.nextTick(check));
      }
    });

    it('should remove object from the cache if it exists', done => {
      streamMock.feed('DELETED', createObject('unknown-object', 1, 160));
      streamMock.feed('DELETED', createObject('evented-object', 2, 156));

      function check() {
        assert.lengthOf(newList, 3);
        assert.lengthOf(modList, 2);
        assert.lengthOf(delList, 1);
        assert.equal(delList[0].name, 'evented-object');
        assert.equal(delList[0].val, 156);
        done();
      }

      if (delList.length > 0) {
        check();
      } else {
        watcher.once('del', () => process.nextTick(check));
      }
    });

    it('should not crash upon error watch event', () => {
      streamMock.feed('ERROR', createObject('error-object', 1, 160));
    });

    it('should not crash upon unknown watch event', () => {
      streamMock.feed('UNKNOWN', createObject('some-object', 1, 160));
    });
  });

  it('should defer event processing when sync is in progress', async () => {
    var getMock = new GetMock();
    var streamMock = new StreamMock();
    var watcher = new Watcher('test', getMock, streamMock, objectFilter);
    var newCount = 0;
    var modCount = 0;

    // Use trick of queueing event with newer generation # for an object which
    // is returned by GET. If event processing is done after GET, then we will
    // see one new and one mod event. If not then we will see only one new
    // event.
    getMock.add(createObject('object', 1, 155));
    streamMock.feed('MODIFIED', createObject('object', 2, 156));
    watcher.on('new', () => newCount++);
    watcher.on('mod', () => modCount++);

    await watcher.start();

    assert.equal(newCount, 1);
    assert.equal(modCount, 1);

    watcher.stop();
    streamMock.end();
  });

  it('should merge old and new objects upon resync', done => {
    var getMock = new GetMock();
    var streamMockTracker = new StreamMockTracker();
    var watcher = new Watcher('test', getMock, streamMockTracker, objectFilter);
    var newObjs = [];
    var modObjs = [];
    var delObjs = [];

    getMock.add(createObject('object-to-be-retained', 1, 155));
    getMock.add(createObject('object-to-be-modified', 1, 155));
    getMock.add(createObject('object-to-be-deleted', 1, 155));

    watcher.on('new', obj => newObjs.push(obj));
    watcher.on('mod', obj => modObjs.push(obj));
    watcher.on('del', obj => delObjs.push(obj));

    watcher.start().then(() => {
      assert.lengthOf(newObjs, 3);
      assert.lengthOf(modObjs, 0);
      assert.lengthOf(delObjs, 0);

      streamMockTracker
        .latest()
        .feed('MODIFIED', createObject('object-to-be-retained', 2, 156));
      getMock.reset();
      getMock.add(createObject('object-to-be-retained', 2, 156));
      getMock.add(createObject('object-to-be-modified', 2, 156));
      getMock.add(createObject('object-to-be-created', 1, 156));

      streamMockTracker.latest().end();

      watcher.once('sync', () => {
        assert.lengthOf(newObjs, 4);
        assert.lengthOf(modObjs, 2);
        assert.lengthOf(delObjs, 1);
        assert.equal(newObjs[3].name, 'object-to-be-created');
        assert.equal(modObjs[0].name, 'object-to-be-retained');
        assert.equal(modObjs[1].name, 'object-to-be-modified');
        assert.equal(delObjs[0].name, 'object-to-be-deleted');

        watcher.stop();
        streamMockTracker.latest().end();
        done();
      });
    });
  });

  it('should recover when watch fails during the sync', async () => {
    class BrokenStreamMock {
      constructor() {
        this.iter = 0;
        this.current = null;
      }

      // We will fail (end) the stream 3x and 4th attempt will succeed
      getStream() {
        let s = new StreamMock();
        this.current = s;
        if (this.iter < 3) {
          s.end();
        }
        this.iter++;
        return s;
      }

      // get the most recently created underlaying stream
      latest() {
        return this.current;
      }
    }

    var getMock = new GetMock(100);
    var brokenStreamMock = new BrokenStreamMock();
    var watcher = new Watcher('test', getMock, brokenStreamMock, objectFilter);

    var start = Date.now();
    await watcher.start();
    var diff = (Date.now() - start) / 1000;

    // three retries will accumulate 7 seconds (1, 2 and 4s)
    assert.isAtLeast(diff, 6);
    assert.isAtMost(diff, 8);
    watcher.stop();
    brokenStreamMock.latest().end();
  }).timeout(10000);

  it('should recover when GET fails during the sync', async () => {
    class BrokenGetMock {
      constructor(stream) {
        this.stream = stream;
        this.iter = 0;
      }

      get() {
        var self = this;
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (self.iter++ < 3) {
              reject({
                statusCode: 404,
                body: {},
              });
              // TODO: defect in current implementation of watcher is that
              // it waits for end of watch connection even when GET fails
              self.stream.latest().end();
            } else {
              resolve({
                statusCode: 200,
                body: { items: [] },
              });
            }
          }, 0);
        });
      }
    }

    var streamMockTracker = new StreamMockTracker();
    var brokenGetMock = new BrokenGetMock(streamMockTracker);
    var watcher = new Watcher(
      'test',
      brokenGetMock,
      streamMockTracker,
      objectFilter
    );

    var start = Date.now();
    await watcher.start();
    var diff = (Date.now() - start) / 1000;

    // three retries will accumulate 7 seconds (1, 2 and 4s)
    assert.isAtLeast(diff, 6);
    assert.isAtMost(diff, 8);
    watcher.stop();
    streamMockTracker.latest().end();
  }).timeout(10000);

  it('should not crash upon invalid json in the stream', done => {
    var getMock = new GetMock();
    var streamMockTracker = new StreamMockTracker();
    var watcher = new Watcher('test', getMock, streamMockTracker, objectFilter);
    var newCount = 0;
    var modCount = 0;

    watcher.on('new', () => newCount++);
    watcher.on('mod', () => modCount++);
    getMock.add(createObject('object', 1, 155));

    watcher.start().then(() => {
      assert.equal(newCount, 1);
      assert.equal(modCount, 0);

      // Following line should be ignored
      streamMockTracker
        .latest()
        .feedRaw('{"type": "ADD", "object":{"non-sense\n');
      streamMockTracker
        .latest()
        .feed('MODIFIED', createObject('object', 2, 156));

      watcher.once('sync', () => {
        watcher.stop();
        streamMockTracker.latest().end();
        assert.equal(newCount, 1);
        assert.equal(modCount, 1);
        done();
      });
      streamMockTracker.latest().end();
    });
  });
};
