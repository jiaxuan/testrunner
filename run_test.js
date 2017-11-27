/**
 * A generator-based test runner for asynchronous code.
 */
'use strict';

module.exports = runTest;

var util = require('util');

/**
 * Entry point of the test runner
 * @param {Number} [tmout] message channel timeout in millisecond
 * @param {Generator} gen  the test wrapped in a generator
 */
function runTest() {
	var tmout = 5000;
	var gen;
	if (arguments.length === 1) {
		gen = arguments[0];
	} else if (arguments.length === 2) {
		tmout = arguments[0];
		gen = arguments[1];
	}
	var runner = new TestRunner(tmout, gen);

	return runner.start();
}

/**
 * Message channel between tests and callbacks.
 * @private
 * @param {Number} tmout default timeout in millisecond
 */
function Channel(tmout) {
	this.SELF = '__' + Date.now() + '__';
	this.queues = {};
	this.queues[this.SELF] = [];
	this.tmout = tmout;
	this.gen = null;
	this.TIMEOUT = { timeout: true, ts: Date.now() };
	this.P_MARKER = Symbol('promise_marker');
}

/**
 * Check if it's timeout data.
 * @public
 * @param  {Object}  obj message object
 * @return {Boolean}     true iff it's the timeout object
 */
Channel.prototype.isTimeout = function(obj) {
	return !util.isNullOrUndefined(obj) && obj === this.TIMEOUT;
};

/**
 * Check if it's promise result.
 */
Channel.prototype.isPromise = function(obj) {
	return !util.isNullOrUndefined(obj) && !util.isNullOrUndefined(obj[this.P_MARKER]);
};

Channel.prototype.isPromiseError = function(obj) {
	return this.isPromise(obj) && obj.type === 'error';
};

Channel.prototype.isPromiseTimeout = function(obj) {
	return this.isPromise(obj) && obj.type === 'timeout';
};

Channel.prototype.isPromiseFulfilled = function(obj) {
	return !this.isPromise(obj);
}

/**
 * Close the channel. This also leads to the shutdown of the test runner.
 * @public
 * @param  {Function} done asynchronouse test callback to signal test completion
 * @return {Array} message to trigger TestRunner shutdown
 */
Channel.prototype.close = function(done) {
	return function() {
		return [ 'end', done ];
	}
};

/**
 * Create a generic callback function to automatically forward callback parameters.
 * @public
 * @param {String} [name] channel name
 * @fixme this doesn't work with MemoryRoot due to the extra arguments it puts into
 *        callbacks, see function call() in MemoryRoot.js
 */
Channel.prototype.forward = function() {
	var name = arguments.length > 0 ? arguments[0] : this.SELF;
	var self = this;
	return function() {
		self.sendTo.apply(self, [name].concat(Array.prototype.slice.call(arguments)));
	}
};

/**
 * Send message to a queue.
 * @private
 */
Channel.prototype._send = function(queue, args) {
	var self = this;
	// check if it's a promise
	if (typeof args[0].then === 'function') {
		var resolved = false;
		var _timer = setTimeout(function() {
			if (!resolved) {
				resolved = true;
				queue.push({ [self.P_MARKER]: true, type: 'timeout' });
			}
		}, args.length > 1 ? args[1] : 5000);
		args[0].then(
			function(result) {
				if (!resolved) {
					clearTimeout(_timer);
					resolved = true;
					queue.push(result);
				}
			},
			function(error) {
				if (!resolved) {
					clearTimeout(_timer);
					resolved = true;
					queue.push({ [self.P_MARKER]: true, type: 'error', error: error });
				}
			}
		);
	} else {
		queue.push(args.length === 1 ? args[0] : Array.prototype.slice.call(args));
	}
};

/**
 * Send a message to the default queue.
 * @public
 */
Channel.prototype.send = function() {
	if (arguments.length === 0) return;
	this._send(this.queues[this.SELF], Array.prototype.slice.call(arguments));
};

/**
 * Receive a message from the default queue.
 * @public
 * @param  {Number} _tmout timeout in milliseconds
 * @return {Object}        the first message in the queue, or the timeout object
 */
Channel.prototype.recv = function(_tmout) {
	return this.recvFrom(this.SELF, _tmout);
};

/**
 * Send a message to a named queue.
 * @public
 * @param {String} name name of the target queue
 */
Channel.prototype.sendTo = function() {
	if (arguments.length === 0) return;
	var name = arguments[0];
	this.queues[name] = this.queues[name] || [];
	this._send(this.queues[name], Array.prototype.slice.call(arguments, 1));
};

/**
 * Receive a message from a named queue.
 * @public
 * @param  {String} name   name of the target queue
 * @param  {Number} _tmout timeout in milliseconds
 * @return {Object}        the first message in the queue or the timeout object.
 */
Channel.prototype.recvFrom = function(name, _tmout) {
	var self = this;
	var start = Date.now();
	var tmout = _tmout || this.tmout;
	return function() {
		var queue = self.queues[name];
		if (queue && queue.length > 0) {
			return [ 'msg', queue.shift() ];
		}
		if (!util.isUndefined(tmout) && Date.now() - start > tmout) {
			return [ 'timeout', self.TIMEOUT ];
		}
		return [ 'retry', null ];
	}
};

/**
 * Sleep.
 * @public
 * @param  {Number} tmout timeout in millisecond
 */
Channel.prototype.sleep = function(tmout) {
	var start = Date.now();
	var self = this;
	return function() {
		if (Date.now() - start > tmout) {
			return [ 'timeout', self.TIMEOUT ];
		}
		return [ 'retry', null ];
	}
};

/**
 * Test runner.
 * @private
 * @param {Number} tmout default message channel timeout in millisecond
 * @param {Generator} gen   the test as generator
 */
function TestRunner(tmout, gen) {
	this.chan = new Channel(tmout);
	this.gen = gen(this.chan);
	this.chan.gen = gen;
}

/**
 * Start the test runner
 * @private
 */
TestRunner.prototype.start = function() {
	var cb;

	var promise = new Promise(function(accept, reject) {
		cb = function(e) {
			if (e)
				reject(e);
			else
				accept();
		};
	});

	this.run(this.gen.next(), cb);

	return promise;
};

/**
 * Test runner main loop
 * @param  {Function} next a function to tell the runner what to do next,
 *                         used by the test code to retrieve the next
 *                         message from test channel.
 */
TestRunner.prototype.run = function(next, cb) {
	var _next = next;
	var self = this;

	function doNext() {
		var value = _next.value;

		if (_next.done || !value) {
			cb && cb();
			return;
		}

		if (value && value.then) {
			// handles promise
			value.then(function(v) {
				_next = self.gen.next(v);
				doNext();
			}, function(e) {
				console.error('Error', e);
				cb && cb(e);
			});
			return;
		}

		var msg = value();
		switch (msg[0]) {
			case 'msg':
				_next = self.gen.next(msg[1]);
				break;
			case 'retry':
				setTimeout(self.run.bind(self, _next), 0);
				return;
			case 'timeout':
				_next = self.gen.next(msg[1]);
				break;
			case 'end':
				msg[1]();
				return;
			default:
				throw new Error('Unkown message type: ' + msg[0]);
		}

		doNext();
	}

	doNext();
};
