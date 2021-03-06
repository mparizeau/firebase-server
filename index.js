/*
 * firebase-server 0.7.1
 * License: MIT.
 * Copyright (C) 2013, 2014, 2015, 2016, Uri Shaked.
 */

'use strict';

var _ = require('lodash');
var WebSocketServer = require('ws').Server;
var Ruleset = require('targaryen/lib/ruleset');
var RuleDataSnapshot = require('targaryen/lib/rule-data-snapshot');
var firebaseHash = require('./lib/firebaseHash');
var TestableClock = require('./lib/testable-clock');
var TokenValidator = require('./lib/token-validator');
var Promise = require('any-promise');
var firebase = require('firebase');
var _log = require('debug')('firebase-server');
var _logRuleFail = require('debug')('firebase-server:rule-fail');

// In order to produce new Firebase clients that do not conflict with existing
// instances of the Firebase client, each one must have a unique name.
// We use this incrementing number to ensure that each Firebase App name we
// create is unique.
var serverID = 0;

function getSnap(ref) {
	return new Promise(function (resolve) {
		ref.once('value', function (snap) {
			resolve(snap);
		});
	});
}

function exportData(ref) {
	return getSnap(ref).then(function (snap) {
		return snap.exportVal();
	});
}

function normalizePath(fullPath) {
	var path = fullPath;
	var isPriorityPath = /\/?\.priority$/.test(path);
	if (isPriorityPath) {
		path = path.replace(/\/?\.priority$/, '');
	}
	return {
		isPriorityPath: isPriorityPath,
		path: path,
		fullPath: fullPath
	};
}

function FirebaseServer(port, name, data) {
	this.name = name || 'mock.firebase.server';

	// Firebase is more than just a "database" now; the "realtime database" is
	// just one of many services provided by a Firebase "App" container.
	// The Firebase library must be initialized with an App, and that app
	// must have a name - either a name you choose, or '[DEFAULT]' which
	// the library will substitute for you if you do not provide one.
	// An important aspect of App names is that multiple instances of the
	// Firebase client with the same name will share a local cache instead of
	// talking "through" our server. So to prevent that from happening, we are
	// choosing a probably-unique name that a developer would not choose for
	// their "real" Firebase client instances.
	var appName = 'firebase-server-internal-' + this.name + '-' + serverID++;

	// We must pass a "valid looking" configuration to initializeApp for its
	// internal checks to pass.
	var config = {
		databaseURL: 'ws://fakeserver.firebaseio.test'
	};
	this.app = firebase.initializeApp(config, appName);
	this.app.database().goOffline();

	this.baseRef = this.app.database().ref();

	this.baseRef.set(data || null);

	this._wss = new WebSocketServer({
		port: port
	});

	this._clock = new TestableClock();
	this._tokenValidator = new TokenValidator(null, this._clock);
	this._ruleFailureLoggingEnabled = true;
	this._verboseFailureLogging = false;

	this._wss.on('connection', this.handleConnection.bind(this));
	_log('Listening for connections on port ' + port);
}

FirebaseServer.prototype = {
	handleConnection: function (ws) {
		_log('New connection from ' + ws._socket.remoteAddress + ':' + ws._socket.remotePort);
		var server = this;
		var authToken = null;

		function send(message) {
			var payload = JSON.stringify(message);
			_log('Sending message: ' + payload);
			try {
				ws.send(payload);
			} catch (e) {
				_log('Send failed: ' + e);
			}
		}

		function authData() {
			var data;
			if (authToken) {
				try {
					data = server._tokenValidator.decode(authToken).d;
				} catch (e) {
					authToken = null;
				}
			}
			return data;
		}

		function pushData(path, data) {
			send({d: {a: 'd', b: {p: path, d: data}}, t: 'd'});
		}

		function permissionDenied(requestId) {
			send({d: {r: requestId, b: {s: 'permission_denied', d: 'Permission denied'}}, t: 'd'});
		}

		function replaceServerTimestamp(data, nowValue) {
			if (_.isEqual(data, firebase.database.ServerValue.TIMESTAMP)) {
				return nowValue || server._clock();
			} else if (_.isObject(data)) {
				return _.mapValues(data, function(d) {
					return replaceServerTimestamp(d, nowValue);
				});
			} else {
				return data;
			}
		}

		function ruleSnapshot(fbRef) {
			return exportData(fbRef.root).then(function (exportVal) {
				return new RuleDataSnapshot(RuleDataSnapshot.convert(exportVal));
			});
		}

		function logRuleFailure(error) {
			if (server._ruleFailureLoggingEnabled) {
				_logRuleFail('Auth data:', authData());
				_logRuleFail(error);
			}
		}

		function tryRead(requestId, path, fbRef) {
			if (server._ruleset) {
				return ruleSnapshot(fbRef).then(function (dataSnap) {
					var result = server._ruleset.tryRead(path, dataSnap, authData());
					if (!result.allowed) {
						permissionDenied(requestId);
						var info = server._verboseFailureLogging ? result.info : result.shortInfo;
						throw new Error('Permission denied for client to read from ' + path + ':\n' + info);
					}
					return true;
				});
			}
			return Promise.resolve(true);
		}

		function tryWrite(requestId, path, fbRef, newData, now) {
			if (server._ruleset) {
				return ruleSnapshot(fbRef).then(function (dataSnap) {
					var result = server._ruleset.tryWrite(path, dataSnap, newData, authData(), false, false, false, now);
					if (!result.allowed) {
						permissionDenied(requestId);
						var info = server._verboseFailureLogging ? result.info : result.shortInfo;
						throw new Error('Permission denied for client to write to ' + path + ':\n' + info);
					}
					return true;
				});
			}
			return Promise.resolve(true);
		}

		function tryPatch(requestId, path, fbRef, newData, now) {
			if (server._ruleset) {
				return ruleSnapshot(fbRef).then(function (dataSnap) {
					var result = server._ruleset.tryPatch(path, dataSnap, newData, authData(), false, false, false, now);
					if (!result.allowed) {
						permissionDenied(requestId);
						var info = server._verboseFailureLogging ? result.info : result.shortInfo;
						throw new Error('Permission denied for client to write to ' + path + ':\n' + info);
					}
					return true;
				});
			}
			return Promise.resolve(true);
		}

		function handleListen(requestId, normalizedPath, fbRef) {
			var path = normalizedPath.path;
			_log('Client listen ' + path);

			tryRead(requestId, path, fbRef)
				.then(function () {
					var sendOk = true;
					fbRef.on('value', function (snap) {
						if (snap.exportVal()) {
							pushData(path, snap.exportVal());
						}
						if (sendOk) {
							sendOk = false;
							send({d: {r: requestId, b: {s: 'ok', d: {}}}, t: 'd'});
						}
					});
				})
				.catch(logRuleFailure);
		}

		function handleUpdate(requestId, normalizedPath, fbRef, newData) {
			var path = normalizedPath.path;
			_log('Client update ' + path);

			// Set the "now" value that will be used for all of the rules
			// checking as this value will be set inside the new data
			// and needs to be consistent
			// If we keep calling Date.now() when checking rules it will
			// be slightly off
			var now = server._clock();
			newData = replaceServerTimestamp(newData, now);

			var checkPermission = Promise.resolve(true);

			if (server._ruleset) {
				checkPermission = tryPatch(requestId, path, fbRef, newData, now);
			}

			checkPermission.then(function () {
				fbRef.update(newData);
				send({d: {r: requestId, b: {s: 'ok', d: {}}}, t: 'd'});
			}).catch(logRuleFailure);
		}

		function handleSet(requestId, normalizedPath, fbRef, newData, hash) {
			_log('Client set ' + normalizedPath.fullPath);

			var progress = Promise.resolve(true);
			var path = normalizedPath.path;

			var now = server._clock();
			newData = replaceServerTimestamp(newData, now);

			if (normalizedPath.isPriorityPath) {
				progress = exportData(fbRef).then(function (parentData) {
					if (_.isObject(parentData)) {
						parentData['.priority'] = newData;
					} else {
						parentData = {
							'.value': parentData,
							'.priority': newData
						};
					}
					newData = parentData;
				});
			}

			progress = progress.then(function () {
				return tryWrite(requestId, path, fbRef, newData, now);
			});

			if (typeof hash !== 'undefined') {
				progress = progress.then(function () {
					return getSnap(fbRef);
				}).then(function (snap) {
					var calculatedHash = firebaseHash(snap.exportVal());
					if (hash !== calculatedHash) {
						pushData(path, snap.exportVal());
						send({d: {r: requestId, b: {s: 'datastale', d: 'Transaction hash does not match'}}, t: 'd'});
						throw new Error('Transaction hash does not match: ' + hash + ' !== ' + calculatedHash);
					}
				});
			}

			progress.then(function () {
				fbRef.set(newData);
				fbRef.once('value', function (snap) {
					pushData(path, snap.exportVal());
					send({d: {r: requestId, b: {s: 'ok', d: {}}}, t: 'd'});
				});
			}).catch(logRuleFailure);
		}

		function handleAuth(requestId, credential) {
			if (server._authSecret === credential) {
				return send({t: 'd', d: {r: requestId, b: {s: 'ok', d: TokenValidator.normalize({ auth: null, admin: true, exp: null }) }}});
			}

			try {
				var decoded = server._tokenValidator.decode(credential);
				authToken = credential;
				send({t: 'd', d: {r: requestId, b: {s: 'ok', d: TokenValidator.normalize(decoded)}}});
			} catch (e) {
				send({t: 'd', d: {r: requestId, b: {s: 'invalid_token', d: 'Could not parse auth token.'}}});
			}
		}

		function handleOnDisconnect(requestId) {
			send({d: {r: requestId, b: {s: 'ok', d: {}}}, t: 'd'});
		}

		function accumulateFrames(data){
			//Accumulate buffer until websocket frame is complete
			if (typeof ws.frameBuffer == 'undefined'){
				ws.frameBuffer = '';
			}

			try {
				var parsed = JSON.parse(ws.frameBuffer + data);
				ws.frameBuffer = '';
				return parsed;
			} catch(e) {
				ws.frameBuffer += data;
			}

			return '';
		}

		ws.on('message', function (data) {
			_log('Client message: ' + data);
			if (data === 0) {
				return;
			}

			var parsed = accumulateFrames(data);

			if (parsed && parsed.t === 'd') {
				var path;
				if (typeof parsed.d.b.p !== 'undefined') {
					path = parsed.d.b.p.substr(1);
				}
				path = normalizePath(path || '');
				var requestId = parsed.d.r;
				var fbRef = path.path ? this.baseRef.child(path.path) : this.baseRef;
				if (parsed.d.a === 'l' || parsed.d.a === 'q') {
					handleListen(requestId, path, fbRef);
				}
				if (parsed.d.a === 'm') {
					handleUpdate(requestId, path, fbRef, parsed.d.b.d);
				}
				if (parsed.d.a === 'p') {
					handleSet(requestId, path, fbRef, parsed.d.b.d, parsed.d.b.h);
				}
				if (parsed.d.a === 'auth' || parsed.d.a === 'gauth') {
					handleAuth(requestId, parsed.d.b.cred);
				}
				if (parsed.d.a === 'om') {
					handleOnDisconnect(requestId);
				}
			}
		}.bind(this));

		send({d: {t: 'h', d: {ts: new Date().getTime(), v: '5', h: this.name, s: ''}}, t: 'c'});
	},

	setRules: function (rules) {
		this._ruleset = new Ruleset(rules);
	},

	getData: function (ref) {
		console.warn('FirebaseServer.getData() is deprecated! Please use FirebaseServer.getValue() instead'); // eslint-disable-line no-console
		var result = null;
		this.baseRef.once('value', function (snap) {
			result = snap.val();
		});
		return result;
	},

	getSnap: function (ref) {
		return getSnap(ref || this.baseRef);
	},

	getValue: function (ref) {
		return this.getSnap(ref).then(function (snap) {
			return snap.val();
		});
	},

	exportData: function (ref) {
		return exportData(ref || this.baseRef);
	},

	close: function (callback) {
		this._wss.close(callback);
	},

	setTime: function (newTime) {
		this._clock.setTime(newTime);
	},

	setAuthSecret: function (newSecret) {
		this._authSecret = newSecret;
		this._tokenValidator.setSecret(newSecret);
	},

	enableRuleFailureLogging: function(enable) {
		this._ruleFailureLoggingEnabled = enable;
	},

	useVerboseFailureLogging: function(value) {
		this._verboseFailureLogging = value;
	}
};

module.exports = FirebaseServer;
