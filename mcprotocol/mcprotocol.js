// MCPROTOCOL - A library for communication to Mitsubishi PLCs over Ethernet from node.js. 
// Currently only FX3U CPUs using FX3U-ENET and FX3U-ENET-ADP modules (Ethernet modules) tested.
// Please report experiences with others.

// The MIT License (MIT)

// Copyright (c) 2015 Dana Moffit

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// EXTRA WARNING - This is BETA software and as such, be careful, especially when 
// writing values to programmable controllers.
//
// Some actions or errors involving programmable controllers can cause injury or death, 
// and YOU are indicating that you understand the risks, including the 
// possibility that the wrong address will be overwritten with the wrong value, 
// when using this library.  Test thoroughly in a laboratory environment.

var net = require("net");
var dgram = require('dgram');
var EventEmitter = require('events').EventEmitter;
var util = require("util");
var inherits = require('util').inherits
var effectiveDebugLevel = 0; // intentionally global, shared between connections
var monitoringTime = 10;

module.exports = MCProtocol;

function MCProtocol() {
	if (!(this instanceof MCProtocol)) return new MCProtocol();
	EventEmitter.call(this);

	var self = this;

	//self.data = {};//for data access
	self.readReq = Buffer.alloc(1000);//not calculated
	self.writeReq;// = new Buffer(1500);//size depends on PLC type!  As Q/L can read/write 950 WDs
	self.queue = [];
	self.resetPending = false;
	self.resetTimeout = undefined;

	self.maxPDU = 255;
	self.netClient = undefined;
	self.connectionState = 0;
	self.requestMaxParallel = 1;
	self.maxParallel = 1;				// MC protocol is read/response.  Parallel jobs not supported.
	self.isAscii = false;
	self.octalInputOutput;
	self.parallelJobsNow = 0;
	self.maxGap = 5;
	self.doNotOptimize = false;
	self.connectCallback = undefined;
	self.readDoneCallback = undefined;
	self.writeDoneCallback = undefined;
	self.connectTimeout = undefined;
	self.PDUTimeout = undefined;
	self.globalTimeout = 4500;
	self.lastPacketSent = undefined;
	self.readPacketArray = [];
	self.writePacketArray = [];
	self.polledReadBlockList = [];
	self.globalReadBlockList = [];
	self.globalWriteBlockList = [];
	self.masterSequenceNumber = 1;
	self.translationCB = function (tag) { return tag };
	self.connectionParams = undefined;
	self.connectionID = 'UNDEF';
	self.addRemoveArray = [];
	self.readPacketValid = false;
	self.connectCBIssued = false;
	self.queueTimer = undefined;
	self.queuePollTime = 50;
	self.queueMaxLength = 50;//avg time on good connection is 20ms.  20 * 50 = 1000ms to process.

}


inherits(MCProtocol, EventEmitter);

MCProtocol.prototype.isConnected = function () {
	var self = this;
	return self.connectionState == 4;
}
MCProtocol.prototype.setDebugLevel = function (level) {
	var l = (level + "").toUpperCase();
	switch (l) {
		case 'TRACE':
			effectiveDebugLevel = 4;
			break;
		case 'DEBUG':
			effectiveDebugLevel = 3;
			break;
		case 'INFO':
			effectiveDebugLevel = 2;
			break;
		case 'WARN':
			effectiveDebugLevel = 1;
			break;
		case 'ERROR':
			effectiveDebugLevel = 0;
			break;
		case 'NONE':
			effectiveDebugLevel = -1;
			break;
	
		default:
			effectiveDebugLevel = level;
	}
	
}

MCProtocol.prototype.nextSequenceNumber = function () {
	var self = this;
	self.masterSequenceNumber += 1;
	if (self.masterSequenceNumber > 32767) {
		self.masterSequenceNumber = 1;
	}
	return self.masterSequenceNumber;
}

MCProtocol.prototype.setTranslationCB = function (cb) {
	var self = this;
	if (typeof cb === "function") {
		outputLog('Translation OK', "TRACE");
		self.translationCB = cb;
	}
}

MCProtocol.prototype.initiateConnection = function (cParam, callback) {
	var self = this;
	if (cParam === undefined) { cParam = { port: 10000, host: '192.168.8.106', ascii: false }; }
	outputLog('Initiate Called - Connecting to PLC with address and parameters...', "DEBUG");
	outputLog(cParam, "DEBUG");
	if (typeof (cParam.name) === 'undefined') {
		self.connectionID = cParam.host;
	} else {
		self.connectionID = cParam.name;
	}
	if (typeof (cParam.ascii) === 'undefined') {
		self.isAscii = false;
	} else {
		self.isAscii = cParam.ascii;
	}
	
	if (typeof (cParam.octalInputOutput) === 'undefined') {
		self.octalInputOutput = false;
	} else {
		self.octalInputOutput = cParam.octalInputOutput;
	}
	if (typeof (cParam.plcType) === 'undefined') {
		self.plcType = MCProtocol.prototype.enumPLCTypes.Q.name;
		self.enumDeviceCodeSpec = MCProtocol.prototype.enumDeviceCodeSpecQ;//default to Q/L series
		outputLog(`plcType not provided, defaulting to Q series PLC`,"WARN");
	} else {
		self.plcType = cParam.plcType;
		if(!MCProtocol.prototype.enumPLCTypes[cParam.plcType]){
			self.plcType = MCProtocol.prototype.enumPLCTypes.Q.name;
			outputLog(`plcType '${cParam.plcType}' unknown. Currently supported types are '${MCProtocol.prototype.enumPLCTypes.keys.join("|")}', defaulting to Q series PLC`,"WARN");
		} 
		
		self.plcSeries = MCProtocol.prototype.enumPLCTypes[self.plcType];
		//not sure how best to handle A/QnA series - not even sure A series can do 3E/4E frames!
		//for now, default to Q (will be overwritten below if user choses 1E frames)
		self.enumDeviceCodeSpec = MCProtocol.prototype['enumDeviceCodeSpec' + self.plcType] || MCProtocol.prototype.enumDeviceCodeSpecQ;

		outputLog(`'plcType' set is ${self.plcType}`,"INFO");
	}

	if (typeof (cParam.frame) === 'undefined') {
		outputLog(`'frame' not provided, defaulting '3E'.  Valid options are 1E, 3E, 4E.`,"WARN");
		self.frame = '3E';
	} else {
		switch (cParam.frame.toUpperCase()) {
			case '1E':
				self.frame = '1E';
				self.enumDeviceCodeSpec = MCProtocol.prototype.enumDeviceCodeSpec1E;
				break;
			case '3E':
				self.frame = '3E';
				break;
			case '4E':
				self.frame = '4E';
			break;
			default:
				self.frame = '3E';
				outputLog(`'frame' ${cParam.frame} is unknown. Defaulting to 3E.  Valid options are 1E, 3E, 4E.`,"WARN");
				break;
		}
		self.frame = cParam.frame;
		outputLog(`'frame' set is ${self.frame}`,"DEBUG");
	}

	if(!self.enumDeviceCodeSpec){
		throw new Error("Error determining device code specification. Check combination of PLC Type and Frame Type are valid");
	}

	if (typeof (cParam.PLCStation) !== 'undefined') {
		self.PLCStation = cParam.PLCStation;
	}
	if (typeof (cParam.PCStation) !== 'undefined') {
		self.PCStation = cParam.PCStation;
	}
	if (typeof (cParam.network) !== 'undefined') {
		self.network = cParam.network;
	}
	if (typeof (cParam.PLCModuleNo) !== 'undefined') {
		self.PLCModuleNo = cParam.PLCModuleNo;
	}
	if (typeof (cParam.queuePollTime) !== 'undefined') {
		self.queuePollTime = cParam.queuePollTime;
	}
	if (typeof (cParam.queueMaxAge) !== 'undefined') {
		self.queueMaxAge = cParam.queueMaxAge;
	} else {
		self.queueMaxAge = 2000;
	}

	self.plcSeries = MCProtocol.prototype.enumPLCTypes[self.plcType];
	self.writeReq = Buffer.alloc(self.plcSeries.requiredWriteBufferSize);//size depends on PLC type!  As Q/L can read/write 950 WDs
	self.connectionParams = cParam;
	self.connectCallback = callback;
	self.connectCBIssued = false;
	if (self.fakeTheConnection)//debug
		self.connectCallback();
	else
		self.connectNow(self.connectionParams, false);

	self.startQueueTimer = function (ms) {
		self.queueTimer = setTimeout(() => {
			self._processQueue()
		}, ms);
	}

	self.startQueueTimer(self.queuePollTime);


	self.processQueueASAP = function () {
		setImmediate(() => {
			outputLog(`🛢️ setImmediate Calling _processQueue() --> `, "TRACE");
			self._processQueue();
		});
	}

	self._processQueue = function () {
		clearTimeout(self.queueTimer);
		try {
			if (!self.queue.length) {
				return;
			}
			// {arg: , cb: , dt: }
			var queueItem = self.queue[0];
			var itemAge = Date.now() - queueItem.dt;
			if (itemAge > self.queueMaxAge) {
				outputLog(`🛢️➡🗑️  Discarding queued '${queueItem.fn}' item ${queueItem.arg} (item age is ${itemAge}ms, max age is ${self.queueMaxAge}ms)`, "WARN")
				self.queue.shift();
				return;//too old - discard
			}
			outputLog(`🛢️➡⚙️ Sending queued '${queueItem.fn}' item ${queueItem.arg}`, "DEBUG");
			var result;
			if (queueItem.fn == "read") {
				result = _readItems(self, queueItem.arg, queueItem.cb, true);
			} else if (queueItem.fn == "write") {
				result = _writeItems(self, queueItem.arg, queueItem.value, queueItem.cb, true);
			}


			let allSent = result.every(function (r) {
				return r.sendStatus == MCProtocol.prototype.enumSendResult.sent;
			});
			if (allSent) {
				outputLog(`🛢️➡⚙️ Successfully sent queued '${queueItem.fn}' item '${queueItem.arg}'. (queue will be shifted to remove this item)`, "DEBUG");
				self.queue.shift();//all sent shift the queued item - its done :)
				return; //no need to continue
			}

			let noneSent = result.every(function (r) {
				return r.sendStatus == MCProtocol.prototype.enumSendResult.notSent;
			});
			if (noneSent) {
				outputLog(`🛢️➡X Queued '${queueItem.fn}' item ${queueItem.arg} NOT sent - will try again soon`, "DEBUG");
				return; //no need to continue
			}

			//by default, if !allSent and !nonSent, then _some_ were sent!
			outputLog(`🛢️➡☠️ Something failed to send '${queueItem.fn}' item '${queueItem.arg}'. Queue will be shifted to remove this item.`, "WARN");
			self.queue.shift();//some sent / some bad - shift the queued item regardless		

		} catch (error) {
			outputLog(`Something went wrong polling the queue: ${error}. Queue will be shifted to remove this item.`, "ERROR");
			self.queue.shift();
		} finally {
			self.startQueueTimer();
		}

	} //_processQueue()


}

MCProtocol.prototype.dropConnection = function () {
	var self = this;
	outputLog(`dropConnection() called`, "TRACE", self.connectionID);
	if(self.connectionParams.protocol == "UDP"){
		//TODO - implement UDP
		try {
			if(self.netClient){
				self.netClient.close();
			}
		} catch (error) {
			outputLog(`dropConnection() caused an error error: ${error}`, "ERROR", self.connectionID);
		}
	} else {
		try {
			if (typeof (self.netClient) !== 'undefined') {
				self.netClient.end();
			}
		} catch (error) {
			outputLog(`dropConnection() caused an error error: ${error}`, "ERROR", self.connectionID);
		}
	}
	self.connectionCleanup(); 
	self.connected = false;
}

MCProtocol.prototype.close = function () {
    this.dropConnection();
};

MCProtocol.prototype.connectNow = function (cParam, suppressCallback) { // TODO - implement or remove suppressCallback
	var self = this;

	if (self.connectionParams.protocol == "UDP") {
		//TODO - implement UDP

		// Track the connection state
		self.connectionState = 1 // 1 = trying to connect

		if (self.netClient) {
			self.connectionState = 0
			self.netClient.removeAllListeners();
			delete self.netClient;
		}
		self.netClient = dgram.createSocket('udp4');
		self.connected = false;
		self.requests = {};

		function close() {
			self.connectionState = 0;
			self.emit('close');
			self.connected = false;
		}



		

		// self.netClient.on('listening', function () {
		// 	self.onUDPConnect.apply(self, arguments);
		// });
		self.netClient.on('close', close);

		//self.netClient.connect();

		self.netClient.write = function(buffer){
			self.netClient.send( buffer, 0, buffer.length, cParam.port, cParam.host, function (err) {
				if (err) {
					self.emit('error');//??
				} 
			});
		}


		//{
		outputLog('UDP Connection Setup to ' + cParam.host + ' on port ' + cParam.port, "DEBUG", self.connectionID);


		self.netClient.removeAllListeners('data');
		self.netClient.removeAllListeners('message');
		self.netClient.removeAllListeners('error');

		self.netClient.on('message', function () {
			self.onResponse.apply(self, arguments);
		});  // We need to make sure we don't add this event every time if we call it on data.  
		self.netClient.on('error', function () {
			self.readWriteError.apply(self, arguments);
		});  // Might want to remove the connecterror listener
		
		self.emit('open');
		if ((!self.connectCBIssued) && (typeof (self.connectCallback) === "function")) {
			self.connectCBIssued = true;
			self.connectCallback();
		}
		//}

		self.connectionState = 4;

	} else {
		// Don't re-trigger.
		if (self.connectionState >= 1) { return; }
		self.connectionCleanup();
		self.netClient = net.connect(cParam, function () {
			self.netClient.setKeepAlive(true, 2500); // For reliable unplug detection in most cases - although it takes 10 minutes to notify
			self.onTCPConnect.apply(self, arguments);
		});

		self.connectionState = 1;  // 1 = trying to connect

		self.netClient.on('error', function () {
			self.connectError.apply(self, arguments);
		});

		self.netClient.on('close', function () {
			self.onClientDisconnect.apply(self, arguments);
		});


		outputLog('<initiating a new connection>', "INFO", self.connectionID);
		outputLog('Attempting to connect to host...', "DEBUG", self.connectionID);
	}

	
}

MCProtocol.prototype.connectError = function (e) {
	var self = this;
	self.emit('error',e);
	// Note that a TCP connection timeout error will appear here.  An MC connection timeout error is a packet timeout.  
	outputLog('We Caught a connect error ' + e.code, "ERROR", self.connectionID);
	if ((!self.connectCBIssued) && (typeof (self.connectCallback) === "function")) {
		self.connectCBIssued = true;
		self.connectCallback(e);
	}
	self.connectionState = 0;
}

MCProtocol.prototype.readWriteError = function (e) {
	var self = this;
	outputLog('We Caught a read/write error ' + e.code + ' - resetting connection', "ERROR", self.connectionID);
	self.emit('error', e);
	self.connectionState = 0;
	self.connectionReset();
}

MCProtocol.prototype.packetTimeout = function (packetType, packetSeqNum) {
	var self = this;
	outputLog('PacketTimeout called with type ' + packetType + ' and seq ' + packetSeqNum, "WARN", self.connectionID);
	if (packetType === "read") {
		outputLog("READ TIMEOUT on sequence number " + packetSeqNum, "WARN", self.connectionID);
		self.readResponse(undefined); //, self.findReadIndexOfSeqNum(packetSeqNum));
		return undefined;
	}
	if (packetType === "write") {
		outputLog("WRITE TIMEOUT on sequence number " + packetSeqNum, "WARN", self.connectionID);
		self.writeResponse(undefined); //, self.findWriteIndexOfSeqNum(packetSeqNum));
		return undefined;
	}
	outputLog("Unknown timeout error.  Nothing was done - this shouldn't happen.", "ERROR", self.connectionID);
}

MCProtocol.prototype.onTCPConnect = function () {
	var self = this;
	outputLog('TCP Connection Established to ' + self.netClient.remoteAddress + ' on port ' + self.netClient.remotePort, "DEBUG", self.connectionID);

	// Track the connection state
	self.connectionState = 4;  // 4 = all connected, simple with MC protocol.  Other protocols have a negotiation/session packet as well.

	self.netClient.removeAllListeners('data');
	self.netClient.removeAllListeners('message');
	self.netClient.removeAllListeners('error');

	self.netClient.on('data', function () {
		self.onResponse.apply(self, arguments);
	});  // We need to make sure we don't add this event every time if we call it on data.  
	self.netClient.on('error', function () {
		self.readWriteError.apply(self, arguments);
	});  // Might want to remove the connecterror listener
	
	self.emit('open');
	if ((!self.connectCBIssued) && (typeof (self.connectCallback) === "function")) {
		self.connectCBIssued = true;
		self.connectCallback();
	}
	return;
}


MCProtocol.prototype.onUDPConnect = function () {
	var self = this;
	outputLog('UDP Connection Established to ' + self.netClient.remoteAddress + ' on port ' + self.netClient.remotePort, "DEBUG", self.connectionID);

	// Track the connection state
	self.connectionState = 4;  // 4 = all connected, simple with MC protocol.  Other protocols have a negotiation/session packet as well.

	self.netClient.removeAllListeners('data');
	self.netClient.removeAllListeners('message');
	self.netClient.removeAllListeners('error');

	self.netClient.on('message', function () {
		self.onResponse.apply(self, arguments);
	});  // We need to make sure we don't add this event every time if we call it on data.  
	self.netClient.on('error', function () {
		self.readWriteError.apply(self, arguments);
	});  // Might want to remove the connecterror listener
	
	self.emit('open');
	if ((!self.connectCBIssued) && (typeof (self.connectCallback) === "function")) {
		self.connectCBIssued = true;
		self.connectCallback();
	}
	return;
}


MCProtocol.prototype.writeItems = function (arg, value, cb) {
	return _writeItems(this, arg, value, cb, false);
}

function _writeItems(self, arg, value, cb, queuedItem) {
	//var self = this;
	var i;
	var reply = [];
	outputLog("Preparing to WRITE " + arg, "DEBUG", self.connectionID);

	//ensure arg is an array regardless of count
	let argArr = arg;
	let valueArr = value;

	if (Array.isArray(arg) != true) {
		argArr = [arg];
		valueArr = [value];
	}

	if (self.isWaiting()) {

		let sendStatus = MCProtocol.prototype.enumSendResult.unknown;

		if (queuedItem) {
			sendStatus = MCProtocol.prototype.enumSendResult.notSent;
			outputLog(`️🛢️➡🚧 queued writeItem '${arg}' still not sent (isWaiting)`, "DEBUG")

		} else if (self.queue.length >= self.queueMaxLength) {
			outputLog(`️🛢️➡🗑️ writeItem '${arg}' discarded, queue full`, "WARN")
			sendStatus = MCProtocol.prototype.enumSendResult.queueFull;
		} else {
			sendStatus = MCProtocol.prototype.enumSendResult.queued;
			self.queue.push({
				arg: arg,
				value: value,
				cb: cb,
				fn: "write",
				dt: Date.now()
			});
			outputLog(`️✏️➡🛢️ writeItem '${arg}' pushed to queue`, "DEBUG")
		}
		reply.push({ TAG: arg, sendStatus: sendStatus });//[item.useraddr] = MCProtocol.prototype.enumSendResult.badRequest;
		return reply;
	}

	let plcitems = [];
	for (i = 0; i < argArr.length; i++) {
		if (typeof argArr[i] === "string") {
			let plcitem = new PLCItem(self);
			plcitem.init(self.translationCB(argArr[i]), argArr[i], self.octalInputOutput, self.frame, self.plcType, valueArr[i]);
			plcitem._instance = "original";
			if (Array.isArray(cb))
				plcitem.cb = cb[i];
			else
				plcitem.cb = cb;
			
			
			plcitems.push(plcitem);
		}
	}

	//do callback for non initialised (bad) items
	plcitems.map(function (item) {
		if (item.initialised == false) {
			if (item.cb) {
				var cbd = new PLCWriteResult(item.useraddr, item.addr, MCProtocol.prototype.enumOPCQuality.badDeviceFailure.value, 0);
				cbd.error = item.initError;
				cbd.problem = true;
				item.cb(true, cbd);
			}
			item.extraInfo = item.initError;
			reply.problem = true;
			let r = {
				TAG: item.useraddr,
				sendStatus: MCProtocol.prototype.enumSendResult.badRequest
			};
			reply.push(r);//[item.useraddr] = MCProtocol.prototype.enumSendResult.badRequest;
		}
	});

	//filter OK items
	var plcitemsInitialised = plcitems.filter(function (item) {
		return item.initialised;
	});

	var preparedCount = self.prepareWritePacket(plcitemsInitialised);

	var plcitemsBuffered = plcitemsInitialised.filter(function (item) {
		return item.bufferized;
	});

	//do callback for items not buffered
	plcitemsInitialised.map(function (item) {
		if (!item.bufferized) {
			if (item.cb) {
				var cbd = new PLCWriteResult(item.useraddr, item.addr, MCProtocol.prototype.enumOPCQuality.bad.value, 0);
				cbd.error = item.lastError;
				cbd.problem = true;
				item.cb(true, cbd);
			}
			item.extraInfo = item.lastError;
			reply.problem = true;
			let r = {
				TAG: item.useraddr,
				sendStatus: MCProtocol.prototype.enumSendResult.badRequest
			};
			reply.push(r);//[item.useraddr] = MCProtocol.prototype.enumSendResult.badRequest;
		}
	});

	let sentCount = 0;
	if (plcitemsBuffered.length) {
		sentCount = self.sendWritePacket();
	}

	plcitemsBuffered.map(function (item) {
		let s = sentCount ? MCProtocol.prototype.enumSendResult.sent : MCProtocol.prototype.enumSendResult.notSent;
		if (s != MCProtocol.prototype.enumSendResult.sent) {
			reply.problem = true;
		}
		let r = {
			TAG: item.useraddr,
			sendStatus: s
		};
		reply.push(r);
	});

	return reply;
}

MCProtocol.prototype.findItem = function (useraddr) {
	var self = this;
	var i;
	var commstate = { value: self.connectionState !== 4, quality: 'OK' };
	if (useraddr === '_COMMERR') { return commstate; }
	for (i = 0; i < self.polledReadBlockList.length; i++) {
		if (self.polledReadBlockList[i].useraddr === useraddr) { return self.polledReadBlockList[i]; }
	}
	return undefined;
}

MCProtocol.prototype.addItems = function (arg, cb) {
	var self = this;
	self.addRemoveArray.push({ arg: arg, cb: cb, action: 'poll' });
}

MCProtocol.prototype.addItemsNow = function (arg, action, cb) {
	var self = this;
	var i;
	outputLog("Adding " + arg, "DEBUG", self.connectionID);
	addItemsFlag = false;
	var addedCount = 0;
	var expectedCount = Array.isArray(arg) ? arg.length : 1;
	if (typeof arg === "string" && arg !== "_COMMERR") {
		//plcitem = stringToMCAddr(self.translationCB(arg), arg, self.octalInputOutput, self.frame, self.plcType);
		let plcitem = new PLCItem(self);
		plcitem.init(self.translationCB(arg), arg, self.octalInputOutput, self.frame, self.plcType, undefined /*not writing*/);
		if (plcitem.initialised) {
			plcitem.action = action;
			plcitem.cb = cb;
			self.polledReadBlockList.push(plcitem);
			addedCount++;
		} else {
			outputLog(`Dropping bad request item '${arg}'`, "WARN");
		}
	} else if (Array.isArray(arg)) {
		for (i = 0; i < arg.length; i++) {
			if (typeof arg[i] === "string" && arg[i] !== "_COMMERR") {
				//plcitem = stringToMCAddr(self.translationCB(arg[i]), arg[i], self.octalInputOutput, self.frame, self.plcType);
				let plcitem = new PLCItem(self);
				plcitem.init(self.translationCB(arg[i]), arg[i], self.octalInputOutput, self.frame, self.plcType, undefined /*not writing*/);
				if (plcitem.initialised) {
					if (Array.isArray(cb))
						plcitem.cb = cb[i];
					else
						plcitem.cb = cb;
					if (Array.isArray(action))
						plcitem.action = action[i];
					else
						plcitem.action = action;
					self.polledReadBlockList.push(plcitem);
					addedCount++;
				} else {
					outputLog(`Dropping bad request item '${arg[i]}'`, "WARN");
				}
			}
		}
	}

	// Validity check.  
	for (i = self.polledReadBlockList.length - 1; i >= 0; i--) {
		if (self.polledReadBlockList[i] === undefined) {
			self.polledReadBlockList.splice(i, 1);
			outputLog("Dropping an undefined request item.", "WARN");
		}
	}
	//	prepareReadPacket();
	self.readPacketValid = false;
}

MCProtocol.prototype.removeItems = function (arg) {
	var self = this;
	self.addRemoveArray.push({ arg: arg, action: 'remove' });
}

MCProtocol.prototype.removeItemsNow = function (arg) {
	var self = this;
	var i;
	self.removeItemsFlag = false;
	if (typeof arg === "undefined") {
		self.polledReadBlockList = [];
	} else if (typeof arg === "string") {
		for (i = 0; i < self.polledReadBlockList.length; i++) {
			outputLog('TCBA ' + self.translationCB(arg), "TRACE");
			if (self.polledReadBlockList[i].addr === self.translationCB(arg)) {
				outputLog('Splicing', "TRACE");
				self.polledReadBlockList.splice(i, 1);
			}
		}
	} else if (Array.isArray(arg)) {
		for (i = 0; i < self.polledReadBlockList.length; i++) {
			for (j = 0; j < arg.length; j++) {
				if (self.polledReadBlockList[i].addr === self.translationCB(arg[j])) {
					self.polledReadBlockList.splice(i, 1);
				}
			}
		}
	}
	self.readPacketValid = false;
	//	prepareReadPacket();
}

MCProtocol.prototype.readAllItems = function (arg) {
	var self = this;
	var i;

	outputLog("Reading All Items (readAllItems was called)", "TRACE", self.connectionID);

	if (typeof arg === "function") {
		self.readDoneCallback = arg;
	} else {
		self.readDoneCallback = doNothing;
	}

	if (self.connectionState !== 4) {
		outputLog("Unable to read when not connected. Return bad values.", "WARN", self.connectionID);
	} // For better behaviour when auto-reconnecting - don't return now

	// Check if ALL are done...  You might think we could look at parallel jobs, and for the most part we can, but if one just finished and we end up here before starting another, it's bad.
	if (self.isWaiting()) {
		outputLog("Waiting to read for all R/W operations to complete.  Will re-trigger readAllItems in 100ms.", "DEBUG");
		setTimeout(function () {
			self.readAllItems.apply(self, arguments);
		}, 100, arg);
		return;
	}

	// Now we check the array of adding and removing things.  Only now is it really safe to do this.  
	self.addRemoveArray.forEach(function (element) {
		outputLog('Adding or Removing ' + util.format(element), "DEBUG", self.connectionID);
		if (element.action === 'remove') {
			self.removeItemsNow(element.arg);
		}
		if (element.action === 'poll' || element.action === 'read') {
			self.addItemsNow(element.arg, element.action, element.cb);
		}
	});

	self.addRemoveArray = []; // Clear for next time.  

	if (!self.readPacketValid) {
		self.prepareReadPacket();
	}

	outputLog("Calling SRP from RAI", "TRACE", self.connectionID);
	self.sendReadPacket(); // Note this sends the first few read packets depending on parallel connection restrictions.   
}

MCProtocol.prototype.readItems = function (arg, cb) {
	return _readItems(this, arg, cb, false);
}

function _readItems(self, arg, cb, queuedItem) {
	//var self = this;
	var i;
	var reply = [];
	outputLog("#readItems() was called)", "TRACE", self.connectionID);

	//ensure arg is an array regardless of count
	let argArr = arg;
	if (Array.isArray(arg) != true) {
		argArr = [arg];
	}

	if (self.connectionState !== 4) {
		outputLog("Unable to read when not connected. Return bad values.", "WARN", self.connectionID);
		//self.queue = [];//empty the queue
	} // For better behaviour when auto-reconnecting - don't return now

	if (self.isWaiting()) {

		let sendStatus = MCProtocol.prototype.enumSendResult.unknown;

		if (queuedItem) {
			sendStatus = MCProtocol.prototype.enumSendResult.notSent;
			outputLog(`️🛢️➡🚧 queued readItem '${arg}' still not sent (isWaiting)`, "DEBUG")

		} else if (self.queue.length >= self.queueMaxLength) {
			outputLog(`️🛢️➡🗑️ readItem '${arg}' discarded, queue full`, "WARN")
			sendStatus = MCProtocol.prototype.enumSendResult.queueFull;
		} else {
			sendStatus = MCProtocol.prototype.enumSendResult.queued;
			self.queue.push({
				arg: arg,
				cb: cb,
				fn: "read",
				dt: Date.now()
			});
			outputLog(`️📒➡🛢️ readItem '${arg}' pushed to queue`, "DEBUG")
		}
		reply.push({ TAG: arg, sendStatus: sendStatus });//[item.useraddr] = MCProtocol.prototype.enumSendResult.badRequest;
		return reply;
	}

	let plcitems = [];
	for (i = 0; i < argArr.length; i++) {
		if (typeof argArr[i] === "string" && argArr[i] !== "_COMMERR") {
			let plcitem = new PLCItem(self);
			plcitem.init(self.translationCB(argArr[i]), argArr[i], self.octalInputOutput, self.frame, self.plcType, undefined /*not writing*/);
			if (Array.isArray(cb))
				plcitem.cb = cb[i];
			else
				plcitem.cb = cb;
			plcitem.action = 'read';
			plcitems.push(plcitem);
		}
	}

	//do callback for non initialised (bad) items
	plcitems.map(function (item) {
		if (item.initialised == false) {
			var cbd = new PLCReadResult(item.useraddr, item.addr, MCProtocol.prototype.enumOPCQuality.badConfigErrInServer.value, 0, undefined, undefined);
			outputLog(`Failed to initialise PLC item. Addr '${item.addr}' may be invalid for this type of PLC and frame setting - item will be dropped`, "ERROR");
			item.cb(true, cbd);
			item.extraInfo = item.initError;
			reply.problem = true;
			let r = {
				TAG: item.useraddr,
				sendStatus: MCProtocol.prototype.enumSendResult.badRequest
			};
			reply.push(r);
		}
	});

	//filter OK items
	var plcitemsInitialised = plcitems.filter(function (item) {
		return item.initialised;
	});

	//check how many good items - return if none
	if (!plcitemsInitialised.length) {
		outputLog("Nothing to send!", "WARN");
		return reply;
	}

	let pp = self.prepareReadPacket(plcitemsInitialised);

	outputLog("Calling sendReadPacket()", "TRACE", self.connectionID);
	var sentCount = self.sendReadPacket(); // Note this sends the first few read packets depending on parallel connection restrictions.   

	plcitemsInitialised.map(function (item) {
		let s = sentCount ? MCProtocol.prototype.enumSendResult.sent : MCProtocol.prototype.enumSendResult.notSent;
		if (s != MCProtocol.prototype.enumSendResult.sent) {
			reply.problem = true;
		}
		let r = {
			TAG: item.useraddr,
			sendStatus: s
		};
		reply.push(r);
	});

	return reply;
}

MCProtocol.prototype.isWaiting = function () {
	var self = this;
	return (self.isReading() || self.isWriting());
}

MCProtocol.prototype.isReading = function () {
	return this.readPacketArray.some(function(el){
		return el.sent;
	});
}

MCProtocol.prototype.isWriting = function () {
	return this.writePacketArray.some(function(el){
		return el.sent;
	});
}

MCProtocol.prototype.clearReadPacketTimeouts = function () {
	var self = this;
	clearPacketTimeouts(self.readPacketArray);
}

MCProtocol.prototype.clearWritePacketTimeouts = function () {
	var self = this;
	outputLog('Clearing write PacketTimeouts', "DEBUG", self.connectionID);
	// Before we initialize the readPacketArray, we need to loop through all of them and clear timeouts.  
	for (i = 0; i < self.writePacketArray.length; i++) {
		clearTimeout(self.writePacketArray[i].timeout);
		self.writePacketArray[i].sent = false;
		self.writePacketArray[i].rcvd = false;
	}
}

MCProtocol.prototype.prepareWritePacket = function (itemList) {
	outputLog("####################  prepareWritePacket() ####################", "TRACE");

	var self = this;
	var requestList = [];			// The request list consists of the block list, split into chunks readable by PDU.  
	var requestNumber = 0, thisBlock = 0, thisRequest = 0;
	var itemsThisPacket;
	var numItems;
	// Sort the items using the sort function, by type and offset.  
	itemList.sort(itemListSorter);

	// Just exit if there are no items.  
	if (itemList.length == 0) {
		return undefined;
	}

	self.globalWriteBlockList = [];
	itemList[0].block = thisBlock;

	// Just push the items into blocks and figure out the write buffers
	for (i = 0; i < itemList.length; i++) {
		if (itemList[i].prepareWriteData()) {
			itemList[i].writeBuffer._instance = itemList[i]._instance;
			self.globalWriteBlockList.push(itemList[i]); // Remember - by reference.  
			var bli = self.globalWriteBlockList[self.globalWriteBlockList.length-1];
			bli.isOptimized = false;
			bli.itemReference = [];
			bli.itemReference.push(itemList[i]);
		} 
  }

	// Split the blocks into requests, if they're too large.  
	for (i = 0; i < self.globalWriteBlockList.length; i++) {
		let block = self.globalWriteBlockList[i];
		var startElement = block.offset;
		var remainingLength = block.byteLengthWrite;
		var remainingTotalArrayLength = block.totalArrayLength;
		var maxByteRequest = block.maxWordLength() * 2; 
		var lengthOffset = 0;
		block.partsBufferized = 0;

		// How many parts?
		block.parts = Math.ceil(block.byteLengthWrite / maxByteRequest);
		outputLog(`globalWriteBlockList[${i}].parts == ${block.parts} for request '${block.useraddr}', .offset (device number) == ${block.offset}, maxByteRequest==${maxByteRequest}`, "DEBUG");

		block.requestReference = [];

		// If we need to spread the sending/receiving over multiple packets...
		for (j = 0; j < block.parts; j++) {
			// create a request for a globalWriteBlockList. 
			requestList[thisRequest] = block.clone(); 
			let reqItem = requestList[thisRequest];
			reqItem._instance = "block clone (request item)";
			reqItem.part = j+1;
			//reqItem.updateSeqNum(self.nextSequenceNumber());
			reqItem.offset = startElement;
			reqItem.byteLengthWrite = Math.min(maxByteRequest, remainingLength);

			if (reqItem.bitNative) {
				reqItem.totalArrayLength = Math.min(maxByteRequest * 2, remainingTotalArrayLength, block.totalArrayLength);
			} else {
				// I think we should be dividing by dtypelen here
				reqItem.totalArrayLength = Math.min(maxByteRequest / block.dtypelen, remainingLength / block.dtypelen, block.totalArrayLength);
			}

			remainingTotalArrayLength -= reqItem.totalArrayLength;
			reqItem.byteLengthWithFill = reqItem.byteLengthWrite;
			reqItem.writeBuffer = block.writeBuffer.slice(lengthOffset, lengthOffset + reqItem.byteLengthWithFill);
			reqItem.writeQualityBuffer = block.writeQualityBuffer.slice(lengthOffset, lengthOffset + reqItem.byteLengthWithFill);
			lengthOffset += reqItem.byteLengthWrite;

			//if we have split a request into parts, then we need to update the device count before creating the comm buffer
			if (block.parts > 1) {
				//reqItem.datatype = 'BYTE';//why???
				//reqItem.dtypelen = 1;//why???
				if (reqItem.bitNative) {
					reqItem.arrayLength = reqItem.totalArrayLength;//globalReadBlockList[thisBlock].byteLength;		
				} else {
					reqItem.arrayLength = reqItem.byteLengthWrite / 2;//globalReadBlockList[thisBlock].byteLength;		
				}
			}
			//generate the comm buffer for this part (with new address offset & length etc)
			reqItem.toBuffer(self.isAscii, self.frame, self.plcType, self.nextSequenceNumber(), self.network, self.PCStation, self.PLCStation, self.PLCModuleNo);
			block.requestReference.push(reqItem);
			block.partsBufferized++;

			outputLog(`Created block part (reqItem) ${reqItem.part} of ${block.parts} for request '${block.useraddr}', .offset (device number) == ${reqItem.offset}, byteLengthWrite==${reqItem.byteLengthWrite}, SeqNum == ${reqItem.seqNum}`, "DEBUG");

			remainingLength -= maxByteRequest;
			if (block.bitNative) {
				startElement += maxByteRequest * 2;
			} else {
				startElement += maxByteRequest / 2;
			}
			thisRequest++;
		}
		block.bufferized = (block.partsBufferized == block.parts);
	}

	self.clearWritePacketTimeouts();
	self.writePacketArray = [];

		// Set up the write packet
	while (requestNumber < requestList.length) {
		numItems = 0;
		self.writePacketArray.push(new PLCPacket());
		var thisPacketNumber = self.writePacketArray.length - 1;
		self.writePacketArray[thisPacketNumber].itemList = [];  // Initialize as array.  
		for (var i = requestNumber; i < requestList.length; i++) {
			if (numItems == 1) {
				break;  // Used to break when packet was full.  Now break when we can't fit this packet in here.  
			}
			requestNumber++;
			numItems++;
			self.writePacketArray[thisPacketNumber].seqNum = requestList[i].seqNum;
			self.writePacketArray[thisPacketNumber].itemList.push(requestList[i]);
		}
	}
	outputLog("writePacketArray Length = " + self.writePacketArray.length, "DEBUG");
	return thisRequest; //return count of prepared requests.  
}

MCProtocol.prototype.prepareReadPacket = function (items) {
	outputLog("####################  prepareReadPacket() ####################", "TRACE");

	const fnstarttime = process.hrtime();

	var self = this;
	var itemList = items || self.polledReadBlockList;				// The items are the actual items requested by the user
	var requestList = [];						// The request list consists of the block list, split into chunks readable by PDU.  	
	var startOfSlice, endOfSlice, oldEndCoil, demandEndCoil;
	let blocklist = []; //self.globalReadBlockList

	// Validity check.  
	for (i = itemList.length - 1; i >= 0; i--) {
		if (itemList[i] === undefined) {
			itemList.splice(i, 1);
			outputLog("Dropping an undefined request item.", "WARN", self.connectionID);
		}
	}
	
	// Sort the items using the sort function, by type and offset.  
	itemList.sort(itemListSorter);

	// Just exit if there are no items.  
	if (itemList.length == 0) {
		return undefined;
	}

	/* DISABLED for now as I need to match the items[x] with the cacheitem[x] and update cacheitem[x].cb to new items[x].cb callback

	//in order to optimise, cache read packets - where the items addresses are used to generate a key
	var packetCacheKey = 'key:';
	for (const item in itemList) {
		if (itemList.hasOwnProperty(item)) {
			packetCacheKey = packetCacheKey + itemList[item].addr + ',';
		}
	}
	outputLog("packetCacheKey = " + packetCacheKey, 3, self.connectionID);
	if (!this.readPacketArrayCache)
		this.readPacketArrayCache = [];

	var cache = this.readPacketArrayCache.find(obj => obj.key == packetCacheKey)
	if (cache) {
		outputLog(`------ ⚡⚡ ------ YEY ------ ⚡⚡ -------  Found cache item packetCacheKey:${packetCacheKey} - returning this (nice speed up) -------- ⚡⚡⚡`, 2, self.connectionID);
		cache.lastUsed = Date.now();
		self.readPacketArray = cache.packetArray;
		self.globalReadBlockList = cache.blocklist;
		self.readPacketValid = true;

		clearPacketTimeouts(self.readPacketArray);
		// //increment seq number
		// for (let p in self.readPacketArray) {
		// 	if (self.readPacketArray.hasOwnProperty(p)) {
		// 		self.readPacketArray[p].seqNum = self.nextSequenceNumber();
		// 	}
		// }


		let fntimetaken = process.hrtime(fnstarttime);
		outputLog(`function '${getFuncName()}()' - time taken ${fntimetaken[0] * 1e9 + fntimetaken[1]} nanoseconds ⌛`, 3);

		return cache;
	}

	outputLog("Cache item not found :(.  packetCacheKey : " + packetCacheKey, 3, self.connectionID);

	//cache maintenance...
	//IMPORTANT: each item cached is approx 99kb (well stringified it is anyhow - so keep cache size reasonable)
	if (this.readPacketArrayCache.length >= 10) {
		//cleanup - delete oldest
		this.readPacketArrayCache.sort((a, b) => a.lastUsed < b.lastUsed);
		let deleteditem = this.readPacketArrayCache.pop();
		outputLog("--------BOO!------- Cache item clean up (Cache exhausted) - removing item packetCacheKey : " + deleteditem.key + ' ---------cache item removed--- ✨✨✨ ', 3, self.connectionID);
	}
	*/

	// ...because you have to start your optimization somewhere.  
	blocklist[0] = itemList[0];
	blocklist[0].itemReference = [];
	blocklist[0].itemReference.push(itemList[0]);

	var maxByteRequest, thisBlock = 0;
	itemList[0].block = thisBlock;

	// Optimize the items into blocks
	for (i = 1; i < itemList.length; i++) {
		maxByteRequest = itemList[i].maxWordLength() * 2; 

		if ((itemList[i].areaMCCode !== blocklist[thisBlock].areaMCCode) ||   	// Can't optimize between areas
			(!self.isOptimizableArea(itemList[i].areaMCCode)) || 					// May as well try to optimize everything.  
			((itemList[i].offset - blocklist[thisBlock].offset + itemList[i].byteLength) > maxByteRequest) ||      	// If this request puts us over our max byte length, create a new block for consistency reasons.
			((itemList[i].offset - (blocklist[thisBlock].offset + blocklist[thisBlock].byteLength) > self.maxGap) && !itemList[i].bitNative) ||
			((itemList[i].offset - (blocklist[thisBlock].offset + blocklist[thisBlock].byteLength) > self.maxGap * 8) && itemList[i].bitNative)) {		// If our gap is large, create a new block.
			// At this point we give up and create a new block.  
			thisBlock = thisBlock + 1;
			blocklist[thisBlock] = itemList[i]; // By reference.  
			//				itemList[i].block = thisBlock; // Don't need to do this.  
			blocklist[thisBlock].isOptimized = false;
			blocklist[thisBlock].itemReference = [];
			blocklist[thisBlock].itemReference.push(itemList[i]);
			//			outputLog("Not optimizing.");
		} else {
			outputLog("Performing optimization of item " + itemList[i].addr + " with " + blocklist[thisBlock].addr, "DEBUG");
			// This next line checks the maximum.  
			// Think of this situation - we have a large request of 40 bytes starting at byte 10.  
			//	Then someone else wants one byte starting at byte 12.  The block length doesn't change.
			//
			// But if we had 40 bytes starting at byte 10 (which gives us byte 10-49) and we want byte 50, our byte length is 50-10 + 1 = 41.  

			if (itemList[i].bitNative) { // Coils and inputs must be special-cased 
				blocklist[thisBlock].byteLength =
					Math.max(
						blocklist[thisBlock].byteLength,
						(Math.floor((itemList[i].requestOffset - blocklist[thisBlock].requestOffset) / 8) + itemList[i].byteLength)
					);
				if (blocklist[thisBlock].byteLength % 2) {  // shouldn't be necessary
					blocklist[thisBlock].byteLength += 1;
				}
			} else {
				blocklist[thisBlock].byteLength =
					Math.max(
						blocklist[thisBlock].byteLength,
						((itemList[i].offset - blocklist[thisBlock].offset) * 2 + Math.ceil(itemList[i].byteLength / itemList[i].multidtypelen)) * itemList[i].multidtypelen
					);
			}
			outputLog("Optimized byte length is now " + blocklist[thisBlock].byteLength, "DEBUG");

			// Point the buffers (byte and quality) to a sliced version of the optimized block.  This is by reference (same area of memory)
			if (itemList[i].bitNative) {  // Again a special case.  
				startOfSlice = (itemList[i].requestOffset - blocklist[thisBlock].requestOffset) / 8; // NO, NO, NO - not the dtype length - start of slice varies with register width.  itemList[i].multidtypelen;
			} else {
				startOfSlice = (itemList[i].requestOffset - blocklist[thisBlock].requestOffset) * 2; // NO, NO, NO - not the dtype length - start of slice varies with register width.  itemList[i].multidtypelen;
			}

			endOfSlice = startOfSlice + itemList[i].byteLength;
			itemList[i].byteBuffer = blocklist[thisBlock].byteBuffer.slice(startOfSlice, endOfSlice);
			itemList[i].qualityBuffer = blocklist[thisBlock].qualityBuffer.slice(startOfSlice, endOfSlice);

			// For now, change the request type here, and fill in some other things.  

			// I am not sure we want to do these next two steps.
			// It seems like things get screwed up when we do this.
			// Since globalReadBlockList[thisBlock] exists already at this point, and our buffer is already set, let's not do this now.   
			// globalReadBlockList[thisBlock].datatype = 'BYTE';
			// globalReadBlockList[thisBlock].dtypelen = 1;
			blocklist[thisBlock].isOptimized = true;
			blocklist[thisBlock].itemReference.push(itemList[i]);
		}
	}

	var thisRequest = 0;

	// Split the blocks into requests, if they're too large.  
	for (i = 0; i < blocklist.length; i++) {
		// Always create a request for a globalReadBlockList. 
		let blockListItem = blocklist[i];
		// How many parts?
		maxByteRequest = blockListItem.maxWordLength() * 2; 
		blockListItem.parts = Math.ceil(blockListItem.byteLength / maxByteRequest);
		var startElement = blockListItem.requestOffset; // try to ignore the offset
		var remainingLength = blockListItem.byteLength;
		var remainingTotalArrayLength = blockListItem.totalArrayLength;

		//initialise the buffers
		blockListItem.byteBuffer.fill(0)// = new Buffer(blockListItem.byteLength);
		blockListItem.qualityBuffer.fill(0)// = new Buffer(blockListItem.byteLength);
		
		blockListItem.requestReference = [];
		
		// If we need to spread the sending/receiving over multiple packets... 
		for (j = 0; j < blockListItem.parts; j++) {
			requestList[thisRequest] = blockListItem.clone();
			let thisReqItem = requestList[thisRequest];
			thisReqItem._instance = "block clone (request item)";

			blockListItem.requestReference.push(thisReqItem);
			thisReqItem.requestOffset = startElement;
			thisReqItem.byteLength = Math.min(maxByteRequest, remainingLength);
			if (thisReqItem.bitNative) {
				thisReqItem.totalArrayLength = Math.min(maxByteRequest * 8, remainingLength * 8, blockListItem.totalArrayLength);
			} else {
				thisReqItem.totalArrayLength = Math.min(maxByteRequest / blockListItem.dtypelen, remainingLength / blockListItem.dtypelen, blockListItem.totalArrayLength);
			}
			thisReqItem.byteLengthWithFill = thisReqItem.byteLength;
			if (thisReqItem.byteLengthWithFill % 2) { thisReqItem.byteLengthWithFill += 1; };
			// Just for now...  I am not sure if we really want to do this in this case.  
			if (blockListItem.parts > 1) {
				thisReqItem.datatype = 'BYTE';
				thisReqItem.dtypelen = 1;
				if (thisReqItem.bitNative) {
					thisReqItem.arrayLength = thisReqItem.totalArrayLength;//globalReadBlockList[thisBlock].byteLength;		
				} else {
					thisReqItem.arrayLength = thisReqItem.byteLength / 2;//globalReadBlockList[thisBlock].byteLength;		
				}
			}
			outputLog(`Created block part (reqItem) ${j+1} of ${blockListItem.parts} for request '${blockListItem.useraddr}', .offset (device number) == ${thisReqItem.offset}, byteLength==${thisReqItem.byteLength}`, "DEBUG");

			remainingLength -= maxByteRequest;
			if (blockListItem.bitNative) {
				//				startElement += maxByteRequest/thisReqItem.multidtypelen;  
				startElement += maxByteRequest * 8;
			} else {
				startElement += maxByteRequest / 2;
			}
			thisRequest++;
		}
		

	}

	// The packetizer...
	var requestNumber = 0;
	var itemsThisPacket;

	self.clearReadPacketTimeouts();
	let packetArray = [];
	packetArray = [];


	while (requestNumber < requestList.length) {
		// Set up the read packet

		var numItems = 0;

		packetArray.push(new PLCPacket());
		var thisPacketNumber = packetArray.length - 1;
		//packetArray[thisPacketNumber].seqNum = self.nextSequenceNumber();
		packetArray[thisPacketNumber].itemList = [];  // Initialize as array.  

		for (var i = requestNumber; i < requestList.length; i++) {
			if (numItems >= 1) {
				break;  // We can't fit this packet in here.  For now, this is always the case as we only have one item in MC protocol.
			}
			requestNumber++;
			numItems++;
			packetArray[thisPacketNumber].itemList.push(requestList[i]);
		}
	}
	self.readPacketArray = packetArray;
	self.globalReadBlockList = blocklist;
	self.readPacketValid = true;
	let rpa = {
		lastUsed: Date.now(),
		/* DISABLED cache for now   key: packetCacheKey, */
		blocklist: blocklist,
		packetArray: packetArray,
	}

	let fntimetaken = process.hrtime(fnstarttime);
	outputLog(`function '${getFuncName()}()' - time taken ${fntimetaken[0] * 1e9 + fntimetaken[1]} nanoseconds ⌛`, "TRACE");
	/* DISABLED cache for now 
	outputLog("------------------  that took aaaaaggggeeeeessss adding packetCacheKey : " + packetCacheKey + ' to the cache for optimisation --------------- 🏺🏺🏺', 3, self.connectionID);
	self.readPacketArrayCache.push(rpa);
	*/

	return rpa;

}

function clearPacketTimeouts(packetArray) {
	outputLog('Clearing read PacketTimeouts', 3);
	// Before we initialize the readPacketArray, we need to loop through all of them and clear timeouts.  
	for (i = 0; i < packetArray.length; i++) {
		clearTimeout(packetArray[i].timeout);
		packetArray[i].sent = false;
		packetArray[i].rcvd = false;
	}
}

function getFuncName() {
	return getFuncName.caller.name
}

MCProtocol.prototype.sendReadPacket = function (arg) {
	var self = this;
	var i, j, curLength, returnedBfr, routerLength;
	var flagReconnect = false;
	var sentCount = 0;
	outputLog("####################  sendReadPacket() ####################", 3, self.connectionID);

	for (i = 0; i < self.readPacketArray.length; i++) {
		let readPacket = self.readPacketArray[i];
		if (readPacket.sent) { continue; }
		if (self.parallelJobsNow >= self.maxParallel) { continue; }
		// From here down is SENDING the packet
		readPacket.reqTime = process.hrtime();

		curLength = 0;
		routerLength = 0;

		// The FOR loop is left in here for now, but really we are only doing one request per packet for now.  
		for (j = 0; j < readPacket.itemList.length; j++) {
			var item = readPacket.itemList[j];
			item.sendTime = Date.now();
			readPacket.seqNum = self.nextSequenceNumber();// readPacket.seqNum;
			item.toBuffer(self.isAscii, self.frame, self.plcType, readPacket.seqNum, self.network, self.PCStation, self.PLCStation, self.PLCModuleNo);	
			returnedBfr = item.buffer.data;
			returnedBfr.copy(self.readReq, curLength);
			curLength += returnedBfr.length;
			outputLog(`The buffer.length of read item '${item.useraddr} [offset:${item.offset}] (seqNum:${item.seqNum})' is '${returnedBfr.length}'...`, "DEBUG");
			outputLog(returnedBfr, "DEBUG");
		}

		outputLog("The final send buffer is...", "DEBUG");
		var sendBuffer = self.readReq.slice(0, curLength);
		if (self.isAscii) {
			outputLog(asciize(sendBuffer), "DEBUG");
			outputLog(binarize(asciize(sendBuffer)), "DEBUG");
		} else {
			outputLog(sendBuffer, "DEBUG");
		}

		if (self.connectionState == 4) {
			readPacket.timeout = setTimeout(function () {
				self.packetTimeout.apply(self, arguments);
			},
				self.globalTimeout, "read", readPacket.seqNum);
			if (self.isAscii) {
				self.netClient.write(asciize(sendBuffer));
			} else {
				self.netClient.write(sendBuffer);  // was 31
			}
			self.lastPacketSent = readPacket;
			self.lastPacketSent.isWritePacket = false;
			self.lastPacketSent.isReadPacket = true;
			sentCount++;
			readPacket.sent = true;
			readPacket.rcvd = false;
			readPacket.timeoutError = false;
			self.parallelJobsNow += 1;

			outputLog('Sent Read Packet SEQ ' + readPacket.seqNum, "DEBUG");
		} else {
			//			outputLog('Somehow got into read block without proper connectionState of 4.  Disconnect.');
			//			connectionReset();
			//			setTimeout(connectNow, 2000, connectionParams);
			// Note we aren't incrementing maxParallel so we are actually going to time out on all our packets all at once.    
			readPacket.sent = true;
			readPacket.rcvd = false;
			readPacket.timeoutError = true;
			if (!flagReconnect) {
				// Prevent duplicates
				outputLog(`Not Sending Read Packet (seqNum==${readPacket.seqNum}) because we are not connected - connection state is ${self.connectionState}`, 0, self.connectionID);
			}
			// This is essentially an instantTimeout.  
			if (self.connectionState == 0) {
				flagReconnect = true;
			}
			outputLog('Requesting PacketTimeout Due to connection state != 4.  readPacket SeqNum == ' + readPacket.seqNum, 1, self.connectionID);
			readPacket.timeout = setTimeout(function () {
				self.packetTimeout.apply(self, arguments);
			}, 0, "read", readPacket.seqNum);
		}
	}

	if (flagReconnect) {
		setTimeout(function () {
			outputLog("The scheduled reconnect from sendReadPacket is happening now", 1, self.connectionID);
			self.connectNow(self.connectionParams);  // We used to do this NOW - not NextTick() as we need to mark connectionState as 1 right now.  Otherwise we queue up LOTS of connects and crash.
		}, 0);
	}
	return sentCount;
}

MCProtocol.prototype.sendWritePacket = function () {
	var self = this;
	var curLength, flagReconnect = false;
	var sentCount = 0
	outputLog("####################  sendWritePacket() ####################", 3, self.connectionID);

	//self.writeInQueue = false;

	for (i = 0; i < self.writePacketArray.length; i++) {
		let writePacket = self.writePacketArray[i];
		if (writePacket.sent) { continue; }
		if (self.parallelJobsNow >= self.maxParallel) { continue; }
		// From here down is SENDING the packet
		writePacket.reqTime = process.hrtime();

		curLength = 0;
		// With MC we generate the simple header inside the packet generator as well
		for (var j = 0; j < writePacket.itemList.length; j++) {
			var seqNum = writePacket.seqNum;
			var item = writePacket.itemList[j];
			item.sendTime = Date.now();
			item.buffer.data.copy(self.writeReq, curLength);
			curLength += item.buffer.data.length;
			//debug point
			// if(item.useraddr == "D2000,1000"){
			// 	curLength = curLength;
			// }
			outputLog(`The buffer.length of write item '${item.useraddr} [offset:${item.offset}] (seqNum:${item.seqNum})' is '${item.buffer.data.length}'...`, "DEBUG");
			outputLog(item.buffer.data, "DEBUG");

		}


		if (self.connectionState === 4) {
			writePacket.timeout = setTimeout(function () {
				self.packetTimeout.apply(self, arguments);
			}, self.globalTimeout, "write", writePacket.seqNum);
			outputLog("Actual Send Packet:", "DEBUG");
			outputLog(self.writeReq.slice(0, curLength), "DEBUG");
			if (self.isAscii) {
				self.netClient.write(asciize(self.writeReq.slice(0, curLength)));  // was 31
				sentCount++;
			} else {
				self.netClient.write(self.writeReq.slice(0, curLength));  // was 31
				sentCount++;
			}
			self.lastPacketSent = writePacket;
			self.lastPacketSent.isWritePacket = true;
			self.lastPacketSent.isReadPacket = false;
			writePacket.sent = true;
			writePacket.rcvd = false;
			writePacket.timeoutError = false;
			self.parallelJobsNow += 1;
			outputLog('Sent Write Packet With Sequence Number ' + writePacket.seqNum, "DEBUG", self.connectionID);
		} else {
			// This is essentially an instantTimeout.  
			writePacket.sent = true;
			writePacket.rcvd = false;
			writePacket.timeoutError = true;

			// Without the scopePlaceholder, this doesn't work.   writePacketArray[i] becomes undefined.
			// The reason is that the value i is part of a closure and when seen "nextTick" has the same value 
			// it would have just after the FOR loop is done.  
			// (The FOR statement will increment it to beyond the array, then exit after the condition fails)
			// scopePlaceholder works as the array is de-referenced NOW, not "nextTick".  
			var scopePlaceholder = writePacket.seqNum;
			process.nextTick(function () {
				self.packetTimeout("write", scopePlaceholder);
			});
			if (self.connectionState == 0) {
				flagReconnect = true;
			}
		}
	}
	if (flagReconnect) {
		setTimeout(function () {
			outputLog("The scheduled reconnect from sendWritePacket is happening now", "DEBUG", self.connectionID);
			self.connectNow(self.connectionParams);  // We used to do this NOW - not NextTick() as we need to mark connectionState as 1 right now.  Otherwise we queue up LOTS of connects and crash.
		}, 0);
	}
	return sentCount;
}

MCProtocol.prototype.isOptimizableArea = function (area) {
	var self = this;
	// For MC protocol always say yes.  
	if (self.doNotOptimize) { return false; } // Are we skipping all optimization due to user request?

	return true;
}

MCProtocol.prototype.onResponse = function (rawdata, rinfo) {
	var self = this;
	var isReadResponse, isWriteResponse, data;
	// Packet Validity Check.  

	if (!self.isAscii) {
		data = rawdata;
	} else {
		data = binarize(rawdata);
		if (typeof (data) === 'undefined') {
			outputLog('Failed ASCII conversion to binary on reply. Ignoring packet.', "WARN");
			outputLog(data, 0);
			return null;
		}
	}

	outputLog("onResponse called with length " + data.length, "TRACE");

	if (data.length < 2) {
		outputLog('DATA LESS THAN 2 BYTES RECEIVED.  NO PROCESSING WILL OCCUR - CONNECTION RESET.', "WARN");
		outputLog(data, 0);
		self.connectionReset();
		return null;
	}

	outputLog('Valid MC Response Received (not yet checked for error)', "DEBUG");

	// Log the receive
	outputLog('Received ' + data.length + ' bytes of data from PLC.', "DEBUG");
	outputLog(data, "DEBUG");

	//1E / 3E frame...
	// On a lot of other industrial protocols the sequence number is coded as part of the 
	// packet and read in the response which is used as a check.	
	// On the MC protocol, we can't do that - so we need to either give up on tracking sequence
	// numbers (this is what we've done) or fake sequence numbers (adds code complexity for no perceived benefit)
	let _isReading = self.isReading();
	let _isWriting = self.isWriting();
	let rh = decodeResponseHeader(self,data)

	//TODO: Consider data having multiple responses (e.g. 4E send multiple commands with seq - multiple responses may arrive in same packet)

	if(!_isReading && !_isWriting){
		outputLog("Unexpected data received " + JSON.stringify(data) + " dropping packet! ", "WARN");
		outputLog(rh,"TRACE");
		return null;
	}
	if(self.frame != "4E"){
		//1E and 3E dont have seq number. Ideally for 4E frame, we would send all frames (upto buffer capability) & match up the responses to the sequence numbers
		rh.seqNum = self.lastPacketSent.seqNum;
	}
	if(rh.valid == false && rh.lastError) {
		outputLog(rh.lastError + " - dropping packet", "ERROR");
		outputLog(rh,"TRACE");
		return null;		
	}
	if(rh.seqNum != self.lastPacketSent.seqNum){
		outputLog(`Unexpected response.  Expected sequence number ${self.lastPacketSent.seqNum}, received ${rh.seqNum} - dropping packet`, "WARN");
		outputLog(rh,"TRACE");
		return null;
	}
	if(rh.valid){
		if (_isReading) {
			isReadResponse = true;
			outputLog("Received Read Response", "DEBUG");
			self.readResponse(data, rh);
		}
		if (_isWriting) {
			isWriteResponse = true;
			outputLog("Received Write Response", "DEBUG");
			self.writeResponse(data, rh);
		}
	} else {
		outputLog("Response is not valid - dropping", "WARN");
		outputLog(rh,"TRACE");
		return null;
	}
}

MCProtocol.prototype.writeResponse = function (data, decodedHeader) {
	var self = this;
	var dataPointer = 2, i, sentPacketNum;

	for (packetCounter = 0; packetCounter < self.writePacketArray.length; packetCounter++) {
		if (self.writePacketArray[packetCounter].sent && !(self.writePacketArray[packetCounter].rcvd)) {
			sentPacketNum = packetCounter;
			break; // Done with the FOR loop
		}
	}

	if (typeof (sentPacketNum) === 'undefined') {
		outputLog('WARNING: Received a write packet when none marked as sent', "WARN", self.connectionID);
		return null;
	}

	if (self.writePacketArray[sentPacketNum].rcvd) {
		outputLog('WARNING: Received a write packet that was already marked as received', "WARN", self.connectionID);
		return null;
	}

	for (itemCount = 0; itemCount < self.writePacketArray[sentPacketNum].itemList.length; itemCount++) {
		//dataPointer = processMBWriteItemORIG(data, self.writePacketArray[sentPacketNum].itemList[itemCount], dataPointer, self.frame);
		dataPointer = processMBWriteItem(decodedHeader, self.writePacketArray[sentPacketNum].itemList[itemCount], dataPointer, self.frame);
		if (!dataPointer) {
			outputLog('Stopping Processing Write Response Packet due to unrecoverable packet error', "ERROR");
			break;
		}
	}

	// Make a note of the time it took the PLC to process the request.  
	self.writePacketArray[sentPacketNum].reqTime = process.hrtime(self.writePacketArray[sentPacketNum].reqTime);
	let wtms = (self.writePacketArray[sentPacketNum].reqTime[0] * 1000) + Math.round(self.writePacketArray[sentPacketNum].reqTime[1] * 10 / 1e6) / 10;
	outputLog('Write Time is ' + wtms + 'ms.', "TRACE");

	if (!self.writePacketArray[sentPacketNum].rcvd) {
		self.writePacketArray[sentPacketNum].rcvd = true;
		self.parallelJobsNow--;
	}
	clearTimeout(self.writePacketArray[sentPacketNum].timeout);

	if (!self.writePacketArray.every(doneSending)) {
		outputLog("writePacketArray not done sending - calling sendWritePacket() again", "WARN");
		self.sendWritePacket();
	} else {
		for (i = 0; i < self.writePacketArray.length; i++) {
			self.writePacketArray[i].sent = false;
			self.writePacketArray[i].rcvd = false;
		}

		anyBadQualities = false;
		let results = {};//items to send to callback

		for (i = 0; i < self.globalWriteBlockList.length; i++) {
			// Post-process the write code and apply the quality.  
			// Loop through the global block list...
			let theItem = self.globalWriteBlockList[i];
			writePostProcess(theItem);
			if (!isQualityOK(theItem.writeQuality)) {
				anyBadQualities = true;
			}
		}
		for (i = 0; i < self.globalWriteBlockList.length; i++) {
			// Post-Post-process the write code, colate results and send callbacks  
			// Loop through the global block list...
			let theItem = self.globalWriteBlockList[i];
			var ttms = theItem.recvTime - theItem.initTime;
			let result = new PLCWriteResult(theItem.useraddr, theItem.addr, theItem.writeQuality, ttms);
			result.deviceCode = theItem.deviceCode;
			result.deviceCodeNotation = theItem.deviceCodeSpec.notation;
			result.deviceCodeType = theItem.deviceCodeSpec.type;
			result.digitSpec = theItem.digitSpec;
			result.dataType = theItem.datatype;
			result.dataTypeByteLength = theItem.dtypelen;
			result.deviceNo = theItem.offset;
			result.bitOffset = theItem.bitOffset;
			results[theItem.useraddr] = result;

			if (typeof (theItem.cb) === 'function') {
				outputLog("Now calling back item.cb().", "DEBUG", self.connectionID);
				outputLog(util.format(result), "DEBUG");
				theItem.cb(!result.isGood, result)
			}
		}
		self.emit('message',anyBadQualities, results);
		if (typeof (self.writeDoneCallback) === 'function') {
			outputLog("Now calling back readDoneCallback(). Sending the following values...", "DEBUG", self.connectionID);
			outputLog(util.format(results), "DEBUG");
			self.writeDoneCallback(anyBadQualities, results);
		}

		self.processQueueASAP();
	}
	
}



MCProtocol.prototype.readResponse = function (data, decodedHeader) {

	//4E:  Subheader (6 bytes), Access route (5 bytes), Response data length (2 bytes), End code (2 bytes), Response data (variable)
	//     Data starts at [15]
	//3E:  Subheader (2 bytes), Access route (5 bytes), Response data length (2 bytes), End code (2 bytes), Response data (variable)
	//     Data starts at [11]
	//error information : Access route, Command, Subcommand.
	var self = this;
	var anyBadQualities, dataPointer, rcvdPacketNum;  // For non-routed packets we start at byte 21 of the packet.  If we do routing it will be more than this.  
	let results = {};//items to send to callback

	outputLog("ReadResponse called", "DEBUG", self.connectionID);

	for (packetCounter = 0; packetCounter < self.readPacketArray.length; packetCounter++) {
		if (self.readPacketArray[packetCounter].sent && !(self.readPacketArray[packetCounter].rcvd)) {
			rcvdPacketNum = packetCounter;
			break; // Done with the FOR loop
		}
	}

	if (typeof (rcvdPacketNum) === 'undefined') {
		outputLog('WARNING: Received a read response packet that was not marked as sent', "WARN", self.connectionID);
		//TODO - fix the network unreachable error that made us do this		
		return null;
	}

	if (self.readPacketArray[rcvdPacketNum].rcvd) {
		outputLog('WARNING: Received a read response packet that was already marked as received', "WARN", self.connectionID);
		return null;
	}

	for (itemCount = 0; itemCount < self.readPacketArray[rcvdPacketNum].itemList.length; itemCount++) {
		//dataPointer = processMBPacketORIG(data, self.readPacketArray[rcvdPacketNum].itemList[itemCount], dataPointer, self.frame);
		dataPointer = processMBPacket(decodedHeader, data, self.readPacketArray[rcvdPacketNum].itemList[itemCount], dataPointer, self.frame);
		if (!dataPointer && typeof (data) !== "undefined") {
			// Don't bother showing this message on timeout.
			outputLog('Received a ZERO RESPONSE Processing Read Packet due to unrecoverable packet error', "ERROR");
			//			break;  // We rely on this for our timeout now.  
		}
	}

	// Make a note of the time it took the PLC to process the request.  
	self.readPacketArray[rcvdPacketNum].reqTime = process.hrtime(self.readPacketArray[rcvdPacketNum].reqTime);
	let rtms = (self.readPacketArray[rcvdPacketNum].reqTime[0] * 1000) + Math.round(self.readPacketArray[rcvdPacketNum].reqTime[1] * 10 / 1e6) / 10;
	outputLog('Read Time is ' + rtms + 'ms.', "DEBUG", self.connectionID);

	// Do the bookkeeping for packet and timeout.  
	if (!self.readPacketArray[rcvdPacketNum].rcvd) {
		self.readPacketArray[rcvdPacketNum].rcvd = true;
		self.parallelJobsNow--;
		if (self.parallelJobsNow < 0) { self.parallelJobsNow = 0; }
	}
	clearTimeout(self.readPacketArray[rcvdPacketNum].timeout);

	if (self.readPacketArray.every(doneSending)) {  // if sendReadPacket returns true we're all done.  
		// Mark our packets unread for next time.  
		outputLog('Every packet done sending', "DEBUG", self.connectionID);
		for (i = 0; i < self.readPacketArray.length; i++) {
			self.readPacketArray[i].sent = false;
			self.readPacketArray[i].rcvd = false;
		}

		anyBadQualities = false;

		// Loop through the global block list...
		for (var i = 0; i < self.globalReadBlockList.length; i++) {
			var lengthOffset = 0;
			let block = self.globalReadBlockList[i];
			// For each block, we loop through all the requests.  Remember, for all but large arrays, there will only be one.  
			for (var j = 0; j < block.requestReference.length; j++) {
				// Now that our request is complete, we reassemble the BLOCK byte buffer as a 
				//copy of each and every request byte buffer.
				let reqRef = block.requestReference[j];
				reqRef.byteBuffer.copy(block.byteBuffer, lengthOffset, 0, reqRef.byteLength);
				reqRef.qualityBuffer.copy(block.qualityBuffer, lengthOffset, 0, reqRef.byteLength);
				lengthOffset += reqRef.byteLength;
			}

			// For each ITEM reference pointed to by the block, we process the item. 
			for (var k = 0; k < block.itemReference.length; k++) {
				let itemRef = block.itemReference[k];
				processMCReadItem(itemRef, self.isAscii, self.frame);
				var ttms = itemRef.recvTime - itemRef.initTime;
				let result = new PLCReadResult(itemRef.useraddr, itemRef.addr, itemRef.quality, ttms, itemRef.value, itemRef.datatype);
				result.deviceCode = itemRef.deviceCode;
				result.deviceCodeNotation = itemRef.deviceCodeSpec.notation;
				result.deviceCodeType = itemRef.deviceCodeSpec.type;
				result.digitSpec = itemRef.digitSpec;
				result.dataType = itemRef.datatype;
				result.dataTypeByteLength = itemRef.dtypelen;
				result.deviceNo = itemRef.offset;
				result.bitOffset = itemRef.bitOffset;

				if (typeof (itemRef.cb) === 'function') {
					outputLog("Now calling back item.cb(). Sending the following values...", "DEBUG", self.connectionID);
					outputLog(util.format(result), "DEBUG");
					itemRef.cb(!result.isGood, result)
				}
				if (itemRef.action == "read") {
					self.removeItems(itemRef.useraddr);
				}
				results[itemRef.useraddr] = result;
			}
		}

		// Inform our user that we are done and that the values are ready for pickup.
		self.emit('message',anyBadQualities, results);
		if (typeof (self.readDoneCallback) === 'function') {
			outputLog("Now calling back readDoneCallback(). Sending the following values...", "DEBUG", self.connectionID);
			outputLog(util.format(results), "DEBUG");
			
			self.readDoneCallback(anyBadQualities, results);
		}

		if (self.resetPending) {
			self.resetNow();
		}

		self.processQueueASAP();

	} else {
		outputLog("Read Request not done - more packets to send - Calling sendReadPacket() from readResponse()", "DEBUG", self.connectionID);
		self.sendReadPacket();
	}

}

MCProtocol.prototype.onClientDisconnect = function (err) {
	var self = this;
	self.emit('close',err);
	outputLog('EIP/TCP DISCONNECTED.');
	self.connectionCleanup();
	self.tryingToConnectNow = false;
}

MCProtocol.prototype.connectionReset = function () {
	var self = this;
	//self.connectionState = 0;
	self.resetPending = true;
	outputLog('ConnectionReset is happening', "DEBUG");
	// The problem is that if we are interrupted before a read can be completed, say we get a bogus packet - we'll never recover.
	if (!self.isReading() && typeof (self.resetTimeout) === 'undefined') { // For now - ignore writes.  && !isWriting()) {	
		self.resetTimeout = setTimeout(function () {
			self.resetNow.apply(self, arguments);
		}, 1500);
	}
	// For now we wait until read() is called again to re-connect.  
}

MCProtocol.prototype.resetNow = function () {
	var self = this;
	outputLog('resetNow is happening', "DEBUG");
	if(self.connectionState == 4){
		if(self.connectionParams.protocol == "UDP"){
				self.netClient.close();
		} else {
				self.netClient.end();
		}
	}
	self.connectionState = 0;
	self.resetPending = false;
	// In some cases, we can have a timeout scheduled for a reset, but we don't want to call it again in that case.
	// We only want to call a reset just as we are returning values.  Otherwise, we will get asked to read // more values and we will "break our promise" to always return something when asked. 
	if (typeof (self.resetTimeout) !== 'undefined') {
		clearTimeout(self.resetTimeout);
		self.resetTimeout = undefined;
		outputLog('Clearing an earlier scheduled reset', "DEBUG");
	}
}

MCProtocol.prototype.connectionCleanup = function () {
	var self = this;
	self.connectionState = 0;
	outputLog('Connection cleanup is happening', "DEBUG");
	if (typeof (self.netClient) !== "undefined") {
		self.netClient.removeAllListeners('message');
		self.netClient.removeAllListeners('data');
		self.netClient.removeAllListeners('error');
		self.netClient.removeAllListeners('connect');
		self.netClient.removeAllListeners('end');
		self.netClient.removeAllListeners();
	}
	clearTimeout(self.connectTimeout);
	clearTimeout(self.PDUTimeout);
	self.clearReadPacketTimeouts();  // Note this clears timeouts.  
	self.clearWritePacketTimeouts();  // Note this clears timeouts.   
}

function outputLog(txt, debugLevel, id) {
	if(effectiveDebugLevel < 0){
		return;//NONE
	}
	var idtext;
	if (typeof (id) === 'undefined') {
		idtext = '';
	} else {
		idtext = ' ' + id;
	}
	var t = process.hrtime();
	var s = new Date().toISOString() + " " + Math.round(t[1] / 1000) + " ";
	
	let level = 3;//debug by default
	if(typeof debugLevel == "number"){
		level = debugLevel;
	} else {
		if(!debugLevel){
			debugLevel = "DEBUG";
		}
		switch (debugLevel) {
			case "TRACE":
				level = 4;
				break;
			case "DEBUG":
				level = 3;
				break;
			case "INFO":
				level = 2;
				break;
			case "WARN":
				level = 1;
				break;
			case "ERROR":
				level = 0;
				break;
			case "NONE":
				level = 65535;
				break;
		}
	}
	if (effectiveDebugLevel >= level) { console.log('[' + s + idtext + '] ' + util.format(txt)); }
}

function doneSending(element) {
	return ((element.sent && element.rcvd) ? true : false);
}

function processMBPacket(decodedHeader, theData, theItem, thePointer, frame) {
	
	// Create a new buffer for the quality.  
	theItem.qualityBuffer = Buffer.alloc(theItem.byteLength);
	theItem.qualityBuffer.fill(MCProtocol.prototype.enumOPCQuality.unknown.value);
	//reset some flags...#
	theItem.endCode = null;
	theItem.endDetail = null;
	theItem.lastError = null;

	if(!decodedHeader || !decodedHeader.valid){
		theItem.valid = false;
		if(decodedHeader)
			theItem.lastError = decodedHeader.lastError || "Response Header is not valid";
		else
			theItem.lastError = "Response Header is not valid";
		outputLog(theItem.lastError, "WARN");  // Can't log more info here as we dont have "self" info
		return 0;   			// Hard to increment the pointer so we call it a malformed packet and we're done.      
	}

	// There is no reported data length to check here - 
	// reportedDataLength = theData[9];
	if (theItem.bitNative && theItem.writeOperation)
		expectedLength = Math.ceil(theItem.arrayLength / 2);//2 bits are return per byte (pg91)
	else
		expectedLength = theItem.byteLength;

	if (decodedHeader.dataLength !== expectedLength) {
		decodedHeader.valid = false;
		theItem.valid = false;
		theItem.lastError = 'Invalid "Response Data Length" - Expected ' + expectedLength + ' but got ' + (decodedHeader.dataLength) + ' bytes.';
		decodedHeader.lastError = theItem.lastError;
		outputLog(theItem.lastError, "ERROR");
		return 1;
	}

	// Looks good so far.  
	// set the data pointer to start of data.
	thePointer = decodedHeader.dataStart;

	var arrayIndex = 0;

	theItem.valid = true;
	theItem.byteBuffer = theData.slice(thePointer); // This means take to end.

	outputLog('Byte Buffer is:', "TRACE");
	outputLog(theItem.byteBuffer, "TRACE");

	outputLog('Marking quality as good.', "TRACE");
	theItem.qualityBuffer.fill(MCProtocol.prototype.enumOPCQuality.good.value);  //  

	return -1; //thePointer;
}




/**
 * Decodes a reply from PLC. NOTE: Different properties will be set depeding on the frame used.  e.g. `.seq` is only valid for 4E frames.
 *
 * @param {*} mcp - this MCProtocol object (required for access to frame)
 * @param {*} theData - the data as it comes direct from the PLC 
 * @returns an object containing the decoded header.  check `.valid` before using values
 */
function decodeResponseHeader(mcp, theData){

	//18.1 1E Message Format pg 389
	// Subheader, End code, Response data
	// Subheader is 1 byte. Value should be between Original Req Subheader + 0x80
	// End Code is 1 byte. Value should be 0 for normal
	// Response Data.  Non for write op, Data for Read op, Abnormal Code if End Code != 0

	//5.2 3E,4E Message Format pg 41 
	// Subheader, Access route, Response data length, End code, Response data

	// Subheader
	//  4E 6byes 0x0054 + serial number + 0x0000 (6b) 1234H (5400 = 4E frame, 3412=1234h, 0000 fixed) 
	//  3E 2bytes 5000  
	// Access route
	// 5bytes
	//* (Byte) Network No ,  Specify the network No. of an access target.
	//* (Byte) PC No. (byte) Specify the network module station No. of an access target
	//* (UINT16 LE) Request destination module I/O No 
	//* (Byte) Request destination module station No. 
	// Response data length
	// 2bytes
	// End code
	// 2bytes
	// Response data - Non for write op, Data for Read op, Error Information if End Code != 0


	//TODO: put these into an enum of frame eg. ("1E":{minResponseLength:2, other:xxx})
	let frame = mcp.frame;
	var minLength = 0;
	switch (frame) {
		case '1E':
			minLength = 2;
			break;
		case '3E':
			minLength = 11;
			break;
		case '4E':
			minLength = 15;
			break;
		default:
			break;
	}

	var reply = {
		expectedResponse: undefined,
		response: undefined,
		endCode: undefined,
		accessRouteNetworkNo: undefined,
		accessPCNo: undefined,
		accessRouteModuleIONo: undefined,
		accessRouteModuleStationNo: undefined,
		seq: undefined,
		length: undefined,
		dataLength: undefined, //length: Noof bytes in "Response data"  deduct 2 from length (to remove endCode)
		dataStart: undefined,
		lastError: "",
		valid: false
	};

	try {
		if (theData.length < minLength) {
			if (typeof (theData) !== "undefined") {
				throw new Error(`Malformed MC Packet - Expected at least '${minLength}' Bytes, however, only received '${theData.length}' Bytes(s)`)
			} else {
				throw new Error("Timeout error - zero length packet");
			}
		}
		
		if (frame == '1E') {
			reply.expectedResponse = theData[0];//set the expected to same as received. As this is a 1E frame, we dont know expected response at this time.  This will be checked later.
			//0x80=128 PG401 Batch read in bit units (command: 00) OK response
			//0x81=129 PG403 Batch read in word units (command: 01) OK response
			//0x82=130 PG405 Batch write in bit units (command: 02) OK response
			//0x83=131 PG407 Batch write in word units (command: 03) OK response
			reply.response = theData[0];
			reply.endCode = theData[1];
			reply.dataLength = theData.length -2; //length: Noof bytes in "Response data"  deduct 2 for length of errcode
			reply.dataStart = 2;
		}

		if (frame == '3E') {
			reply.expectedResponse = 0x00D0;
			reply.response = theData.readUInt16LE(0);
			reply.accessRouteNetworkNo = theData[2];
			reply.accessPCNo = theData[3];
			reply.accessRouteModuleIONo = theData.readUInt16LE(4);
			reply.accessRouteModuleStationNo = theData[6];
			reply.length = theData.readUInt16LE(7); //length Noof bytes from start of "end code" ~ end of "Response data"
			reply.endCode = theData.readUInt16LE(9);
			//rExtraInfo = theData.readUInt16LE(11);
			reply.dataLength = reply.length -2; //length: Noof bytes in "Response data"  deduct 2 for length of errcode
			reply.dataStart = 11;
		}

		if (frame == '4E') {
			reply.expectedResponse = 0x00D4;
			reply.response = theData.readUInt16LE(0); 
			reply.seqNum = theData.readUInt16LE(2); 
			let xxx = theData.readUInt16LE(4); //dummy
			reply.accessRouteNetworkNo = theData[6];
			reply.accessPCNo = theData[7];
			reply.accessRouteModuleIONo = theData.readUInt16LE(8); 
			reply.accessRouteModuleStationNo = theData[10];
			reply.length = theData.readUInt16LE(11);//length Noof bytes from start of "end code" ~ end of "Response data"
			reply.endCode = theData.readUInt16LE(13);
			//rExtraInfo = theData.readUInt16LE(15);
			reply.dataLength = reply.length -2; //length: Noof bytes in "Response data"  deduct 2 for length of errcode
			reply.dataStart = 15;

		}
		if (reply.response !== reply.expectedResponse) {
			reply.lastError = 'Invalid MC - Expected first part to be ' + decimalToHexString(reply.expectedResponse) + ' - got ' + decimalToHexString(reply.response) + " (" + reply.response + ")";
			return reply; 
		}
	
		if (reply.endCode !== 0) {
			reply.endDetail = theData.slice(reply.dataStart);//all response data is error info when endcode is not 0
			reply.lastError = `Reply End code '${reply.endCode} is not zero. For extra info, see "endDetail" `;
			return reply; 
		}
	} catch (error) {
		reply.lastError = `Exception - ${error}`;
		return reply; 
	}
	reply.valid = true;
	return reply;
}


function processMBWriteItem(decodedHeader, theItem, thePointer, frame) {
	// Create a new buffer for the quality.  
	// theItem.writeQualityBuffer = new Buffer(theItem.byteLength);
	theItem.writeQualityBuffer.fill(MCProtocol.prototype.enumOPCQuality.unknown.value);
	//reset some flags...#
	theItem.endCode = null;
	theItem.endDetail = null;
	theItem.lastError = null;
	if(!decodedHeader){
		theItem.valid = false;
		theItem.endCode = -1; //TODO: Determine a suitable endCode (or none!)
		theItem.lastError = "Response Header is not valid / empty (should not happen)";
		theItem.writeQualityBuffer.fill(MCProtocol.prototype.enumOPCQuality.bad.value);
		outputLog(theItem.lastError, "WARN");   
		return 0;   			      
	}

	if(!decodedHeader.valid){
		theItem.valid = false;
		theItem.lastError = decodedHeader.lastError || "Response Header is not valid";
		theItem.endCode = decodedHeader.endCode; 
		theItem.endDetail = decodedHeader.endDetail;
		//TODO: Fill quality with more specific / appropriate value (based on endCode)
		theItem.writeQualityBuffer.fill(MCProtocol.prototype.enumOPCQuality.bad.value);
		outputLog(theItem.lastError, "WARN");  
		return 0;   			      
	}

	//success
	theItem.writeQualityBuffer.fill(MCProtocol.prototype.enumOPCQuality.good.value);
	return -1;
}

function writePostProcess(theItem) {
	var thePointer = 0;
	theItem.recvTime = Date.now();

	if (theItem.arrayLength === 1) {
		let qual = theItem.writeQualityBuffer[0];
		let qualItem = MCProtocol.prototype.enumOPCQuality[qual];
		if (!qualItem)
			qualItem = MCProtocol.prototype.enumOPCQuality.uncertain;
		theItem.writeQuality = qualItem.desc;
	} else {
		// Array value.
		theItem.writeQuality = [];
		for (arrayIndex = 0; arrayIndex < theItem.arrayLength; arrayIndex++) {

			let qual = theItem.writeQualityBuffer[thePointer];
			let qualItem = MCProtocol.prototype.enumOPCQuality[qual];
			if (!qualItem)
				qualItem = MCProtocol.prototype.enumOPCQuality.uncertain;

			theItem.writeQuality[arrayIndex] = qualItem.desc;

			if (theItem.datatype == 'BIT') {
				// For bit arrays, we have to do some tricky math to get the pointer to equal the byte offset. 
				// Note that we add the bit offset here for the rare case of an array starting at other than zero.  We either have to 
				// drop support for this at the request level or support it here.  
				if ((((arrayIndex + theItem.bitOffset + 1) % 8) == 0) || (arrayIndex == theItem.arrayLength - 1)) {
					thePointer += theItem.dtypelen;
				}
			} else {
				// Add to the pointer every time.  
				thePointer += theItem.dtypelen;
			}
		}
	}
}


function processMCReadItem(theItem, isAscii, frame) {

	var thePointer = 0, tempBuffer = Buffer.alloc(4);
	theItem.recvTime = Date.now();
	let quals = MCProtocol.prototype.enumOPCQuality;
	if (theItem.arrayLength > 1) {
		// Array value.  
		if (theItem.datatype != 'C' && theItem.datatype != 'CHAR') {
			theItem.value = [];
			theItem.quality = [];
		} else {
			theItem.value = '';
			theItem.quality = '';
		}
		var bitShiftAmount = theItem.bitOffset;
		if (theItem.bitNative) {
			bitShiftAmount = theItem.remainder;
		}
		var stringNullFound = false;
		
		for (arrayIndex = 0; arrayIndex < theItem.arrayLength; arrayIndex++) {

			let qual = theItem.qualityBuffer[thePointer];
			let qualItem = quals[qual];
			if (!qualItem)
				qualItem = quals.uncertain;
			if (qualItem.value !== quals.good.value && qualItem.value !== quals.goodForced.value) {
				outputLog("Logging a Bad Quality thePointer " + thePointer, "WARN");
				// If we're a string, quality is not an array.
				let dts = MCProtocol.prototype.enumDataTypes;
				let dt = dts[theItem.datatype];
				if (dt && dt == dts.CHAR || dt == dts.STR) {
					theItem.quality = qualItem.desc;
					theItem.value = theItem.badValue();
					break;
				} else {
					theItem.quality.push(qualItem.desc);
					theItem.value.push(theItem.badValue());
				}

			} else {
				// If we're a string, quality is not an array.
				if (theItem.quality instanceof Array) {
					theItem.quality.push(qualItem.desc);
				} else {
					theItem.quality = qualItem.desc;
				}
				switch (theItem.datatype) {
					case "FLOAT":
					case "REAL":
						if (isAscii) {
							theItem.value.push(theItem.byteBuffer.getFloatBESwap(thePointer));
						} else {
							theItem.value.push(theItem.byteBuffer.readFloatLE(thePointer));
						}
						break;
					case "DWORD":
						if (isAscii) {
							theItem.value.push(theItem.byteBuffer.getUInt32BESwap(thePointer));
						} else {
							theItem.value.push(theItem.byteBuffer.readUInt32LE(thePointer));
						}
						break;
					case "DINT":
						if (isAscii) {
							theItem.value.push(theItem.byteBuffer.getInt32BESwap(thePointer));
						} else {
							theItem.value.push(theItem.byteBuffer.readInt32LE(thePointer));
						}
						break;
					case "INT":
						if (isAscii) {
							theItem.value.push(theItem.byteBuffer.readInt16BE(thePointer));
						} else {
							theItem.value.push(theItem.byteBuffer.readInt16LE(thePointer));
						}
						break;
					case "UINT":
					case "WORD":
						if (isAscii) {
							theItem.value.push(theItem.byteBuffer.readUInt16BE(thePointer));
						} else {
							theItem.value.push(theItem.byteBuffer.readUInt16LE(thePointer));
						}
						break;
					case "BIT":
						if (theItem.bitNative) {
							if (isAscii) {
								theItem.value.push(((theItem.byteBuffer.readUInt16BE(thePointer) >> (bitShiftAmount)) & 1) ? true : false);
							} else {
								theItem.value.push(((theItem.byteBuffer.readUInt16LE(thePointer) >> (bitShiftAmount)) & 1) ? true : false);
							}
						} else {
							if (isAscii) {
								theItem.value.push(((theItem.byteBuffer.readUInt16BE(thePointer) >> (bitShiftAmount)) & 1) ? true : false);
							} else {
								theItem.value.push(((theItem.byteBuffer.readUInt16LE(thePointer) >> (bitShiftAmount)) & 1) ? true : false);
							}
						}
						break;
					case "B":
					case "BYTE":
						if (isAscii) {
							if (arrayIndex % 2) {
								theItem.value.push(theItem.byteBuffer.readUInt8(thePointer - 1));
							} else {
								theItem.value.push(theItem.byteBuffer.readUInt8(thePointer + 1));
							}
						} else {
							theItem.value.push(theItem.byteBuffer.readUInt8(thePointer));
						}
						break;

					case "C":
					case "CHAR":
						// Convert to string.  
						if (isAscii) {
							if (arrayIndex % 2) {
								theItem.value += String.fromCharCode(theItem.byteBuffer.readUInt8(thePointer - 1));
							} else {
								theItem.value += String.fromCharCode(theItem.byteBuffer.readUInt8(thePointer + 1));
							}
						} else {
							var ch = theItem.byteBuffer.readUInt8(thePointer);
							if (ch > 0 && !stringNullFound)
								theItem.value += String.fromCharCode(ch)
							else
								stringNullFound = true;
						}
						break;

					default:
						outputLog(`data type ${theItem.datatype} is not valid.`, "WARN");
						return 0;
				}
			}
			if (theItem.datatype == 'BIT') {
				// For bit arrays, we have to do some tricky math to get the pointer to equal the byte offset. 
				// Note that we add the bit offset here for the rare case of an array starting at other than zero.  We either have to 
				// drop support for this at the request level or support it here.  
				bitShiftAmount++;
				if (theItem.bitNative) {
					if ((((arrayIndex + theItem.remainder + 1) % 16) == 0) || (arrayIndex == theItem.arrayLength - 1)) { // NOTE: The second or case is for the case of the end of an array where we increment for next read - not important for MC protocol
						thePointer += theItem.dtypelen;
						bitShiftAmount = 0;
					}
				} else {
					// Never tested
					if ((((arrayIndex + theItem.bitOffset + 1) % 16) == 0) || (arrayIndex == theItem.arrayLength - 1)) {
						thePointer += theItem.dtypelen; // I guess this is 1 for bits.  
						bitShiftAmount = 0;
					}
				}
			} else {
				// Add to the pointer every time.  
				thePointer += theItem.dtypelen;
			}
		}
	} else {
		// Single value.  
		let qual = theItem.qualityBuffer[thePointer];
		let qualItem = quals[qual];
		if (!qualItem)
			qualItem = quals.uncertain;
		if (qualItem.value !== quals.good.value && qualItem.value !== quals.goodForced.value) {
			theItem.value = theItem.badValue();
			theItem.quality = (qualItem.desc);
			outputLog("Item Quality is Bad", "WARN");
		} else {
			theItem.quality = (qualItem.desc);
			outputLog("Item Datatype (single value) is " + theItem.datatype, "TRACE");
			switch (theItem.datatype) {
				case "FLOAT":
				case "REAL":
					if (isAscii) {
						theItem.value = theItem.byteBuffer.getFloatBESwap(thePointer);
					} else {
						theItem.value = theItem.byteBuffer.readFloatLE(thePointer);
					}
					break;
				case "DWORD":
					if (isAscii) {
						theItem.value = theItem.byteBuffer.getUInt32BESwap(thePointer);
					} else {
						theItem.value = theItem.byteBuffer.readUInt32LE(thePointer);
					}
					break;
				case "DINT":
					if (isAscii) {
						theItem.value = theItem.byteBuffer.getInt32BESwap(thePointer);
					} else {
						theItem.value = theItem.byteBuffer.readInt32LE(thePointer);
					}
					break;
				case "INT":
					if (isAscii) {
						theItem.value = theItem.byteBuffer.readInt16BE(thePointer);
					} else {
						theItem.value = theItem.byteBuffer.readInt16LE(thePointer);
					}
					break;
				case "UINT":
				case "WORD":
					if (isAscii) {
						theItem.value = theItem.byteBuffer.readUInt16BE(thePointer);
					} else {
						theItem.value = theItem.byteBuffer.readUInt16LE(thePointer);
					}
					break;
				case "BIT":
					if (theItem.bitNative) {
						if (isAscii) {
							theItem.value = (((theItem.byteBuffer.readUInt16BE(thePointer) >> (theItem.remainder)) & 1) ? true : false);
						} else {
							theItem.value = (((theItem.byteBuffer.readUInt16LE(thePointer) >> (theItem.remainder)) & 1) ? true : false);
						}
					} else {
						if (isAscii) {
							theItem.value = (((theItem.byteBuffer.readUInt16BE(thePointer) >> (theItem.bitOffset)) & 1) ? true : false);
						} else {
							theItem.value = (((theItem.byteBuffer.readUInt16LE(thePointer) >> (theItem.bitOffset)) & 1) ? true : false);
						}
					}
					break;
				case "B":
				case "BYTE":
					// No support as of yet for signed 8 bit.  This isn't that common.  
					if (isAscii) {
						theItem.value = theItem.byteBuffer.readUInt8(thePointer + 1);
					} else {
						theItem.value = theItem.byteBuffer.readUInt8(thePointer);
					}
					break;
				case "C":
				case "CHAR":
					// No support as of yet for signed 8 bit.  This isn't that common.  
					if (isAscii) {
						theItem.value = String.fromCharCode(theItem.byteBuffer.readUInt8(thePointer + 1));
					} else {
						var ch = theItem.byteBuffer.readUInt8(thePointer);
						if (ch > 0)
							theItem.value = String.fromCharCode(ch);
						else
							theItem = "";
					}
					break;
				default:
					outputLog(`data type ${theItem.datatype} is not valid.`);
					return 0;
			}
		}
		thePointer += theItem.dtypelen;
	}

	if (((thePointer) % 2)) { // Odd number.  
		thePointer += 1;
	}

	return thePointer; // Should maybe return a value now???
}


function isQualityOK(obj) {

	var isGood = function (q) {
		if (typeof q === "object") {
			if (q.value == MCProtocol.prototype.enumOPCQuality.good.value || obj.value == MCProtocol.prototype.enumOPCQuality.goodForced.value) { return true; }
		} else if (typeof q === "string") {
			if (q == 'OK' || q == MCProtocol.prototype.enumOPCQuality.good.desc || q == MCProtocol.prototype.enumOPCQuality.goodForced.desc) { return true; }
		} else if (typeof obj === "number") {
			if (q == MCProtocol.prototype.enumOPCQuality.good.value || q == MCProtocol.prototype.enumOPCQuality.goodForced.value) { return true; }
		}
		return false;
	}

	if (Array.isArray(obj)) {
		for (i = 0; i < obj.length; i++) {
			if (isGood(obj[i]) == false) {
				return false;
			}
		}
	} else {
		return isGood(obj);
	}

	return true;
}

Buffer.prototype.setPointer = function (pos) {
	this.pointer = pos;
	return ptr;
}

Buffer.prototype.setFloatBESwap = function (val, ptr) {
	var newBuf = Buffer.alloc(4);
	newBuf.writeFloatBE(val, 0);
	this[ptr + 2] = newBuf[0];
	this[ptr + 3] = newBuf[1];
	this[ptr + 0] = newBuf[2];
	this[ptr + 1] = newBuf[3];
	return ptr + 4;
}


Buffer.prototype.getFloatBESwap = function(ptr) {
	var newBuf = Buffer.alloc(4);
	newBuf[0] = this[ptr + 2];
	newBuf[1] = this[ptr + 3];
	newBuf[2] = this[ptr + 0];
	newBuf[3] = this[ptr + 1];
	return newBuf.readFloatBE(0);
}


Buffer.prototype.getInt32BESwap = function(ptr) {
	var newBuf = Buffer.alloc(4);
	newBuf[0] = this[ptr + 2];
	newBuf[1] = this[ptr + 3];
	newBuf[2] = this[ptr + 0];
	newBuf[3] = this[ptr + 1];
	return newBuf.readInt32BE(0);
}

Buffer.prototype.setInt32BESwap = function(val,ptr) {
	var newBuf = Buffer.alloc(4);
	newBuf.writeInt32BE(Math.round(val), 0);
	this[ptr + 2] = newBuf[0];
	this[ptr + 3] = newBuf[1];
	this[ptr + 0] = newBuf[2];
	this[ptr + 1] = newBuf[3];
	return ptr + 4;
}

Buffer.prototype.getUInt32BESwap = function(ptr) {
	var newBuf = Buffer.alloc(4);
	newBuf[0] = this[ptr + 2];
	newBuf[1] = this[ptr + 3];
	newBuf[2] = this[ptr + 0];
	newBuf[3] = this[ptr + 1];
	return newBuf.readUInt32BE(0);
}

Buffer.prototype.setUInt32BESwap = function(val,ptr) {
	var newBuf = Buffer.alloc(4);
	newBuf.writeUInt32BE(Math.round(val), 0);
	this[ptr + 2] = newBuf[0];
	this[ptr + 3] = newBuf[1];
	this[ptr + 0] = newBuf[2];
	this[ptr + 1] = newBuf[3];
	return ptr + 4;
}

Buffer.prototype.addByte = function (v) {
	if (this.pointer == undefined)
		this.pointer = 0;
	this.writeUInt8(v, this.pointer);
	this.pointer += 1;
	return this.pointer;
}

Buffer.prototype.addUint16LE = function (v) {
	if (this.pointer == undefined)
		this.pointer = 0;
	this.writeUInt16LE(v, this.pointer);
	this.pointer += 2;
	return this.pointer;
}

Buffer.prototype.addUint32LE = function (v) {
	if (this.pointer == undefined)
		this.pointer = 0;
	this.writeUInt32LE(v, this.pointer);
	this.pointer += 4;
	return this.pointer;
}

//https://dl.mitsubishielectric.com/dl/fa/document/manual/plc/sh080008/sh080008x.pdf PG 464
MCProtocol.prototype.enumMaxWordLength = _enum({
	batchReadWordUnits04010000: { //Batch read in word units (command: 0401) PG86
		description: "Batch read in word units",
		command: 0x0401, subCommand: 0x0000,
		"BITDevice": {A:64, QnA:480, Q:960, L:960 /*, R:960 does iQR support subCommand 0x0? */}, 
		"WORDDevice": {A:32, QnA:480, Q:960, L:960/*, R:960 does iQR support subCommand 0x0? */}, 
	},
	batchReadWordUnits04010002: { //Batch read in word units (command: 0401) PG86
		description: "Batch read in word units",
		command: 0x0401, subCommand: 0x0002,
		"BITDevice": {R:960}, 
		"WORDDevice": {R:960}, 
	},
	batchReadBitUnits04010001: { //Batch read in bit units (command: 0401) PG90
		description: "Batch read in word units",
		command: 0x0401, subCommand: 0x0001,
		"BITDevice": {A:64, QnA:896, Q:1792, L:1792 /*, R:1792 does iQR support subCommand 0x1? */}, 
		"WORDDevice": {A:64, QnA:896, Q:1792, L:1792/*, R:1792 does iQR support subCommand 0x1? */}, 
	},
	batchReadBitUnits04010003: { //Batch read in bit units (command: 0401) PG90
		description: "Batch read in word units",
		command: 0x0401, subCommand: 0x0003,
		"BITDevice": {R:1792}, 
		"WORDDevice": {R:1792}, 
	},
	batchWriteWordUnits14010000: { //Batch Write in word units (command: 1401) PG92
		description: "Batch Write in word units",
		command: 0x1401, subCommand: 0x0000,
		"BITDevice": {A:10, QnA:480, Q:960, L:960 /*, R:960 does iQR support subCommand 0x0? */}, 
		"WORDDevice": {A:64, QnA:480, Q:960, L:960/*, R:960 does iQR support subCommand 0x0? */}, 
		"DWORDDevice": {Q:960, L:960/*, R:960 does iQR support subCommand 0x0? */}, 
	},
	batchWriteWordUnits14010002: { //Batch Write in word units (command: 1401) PG92
		description: "Batch Write in word units",
		command: 0x1401, subCommand: 0x0002,
		"BITDevice": {R:960}, 
		"WORDDevice": {R:960}, 
		"DWORDDevice": {R:960}, 
	},
	batchWriteBitUnits14010001: { //Batch Write in Bit units (command: 1401) PG95
		description: "Batch Write in Bit units",
		command: 0x1401, subCommand: 0x0001,
		"BITDevice": {A:10, QnA:896, Q:1792, L:1792 /*, R:1792 does iQR support subCommand 0x0? */}, 
		"WORDDevice": {A:64, QnA:896, Q:1792, L:1792/*, R:1792 does iQR support subCommand 0x0? */}, 
		"DWORDDevice": {Q:960, L:960/*, R:960 does iQR support subCommand 0x0? */}, 
	},
	batchWriteBitUnits14010003: { //Batch Write in Bit units (command: 1401) PG95
		description: "Batch Write in Bit units",
		command: 0x1401, subCommand: 0x0003,
		"BITDevice": {R:1792}, 
		"WORDDevice": {R:1792}, 
		"DWORDDevice": {R:1792}, 
	},

});

MCProtocol.prototype.enumPLCTypes = _enum({
	"A": {wordDeviceMax: 64, bitWriteDeviceMax : 32 /*160 points PG96*/,  bitReadDeviceMax : 64 /*256 points PG91*/, requiredWriteBufferSize: ((64*2) + 30/*for frame etc*/) },
	"QnA": {wordDeviceMax: 480, bitWriteDeviceMax: 480, bitReadDeviceMax: 480, requiredWriteBufferSize: ((480*2) + 30 /*for frame etc*/)},
	"Q": {wordDeviceMax: 960, bitWriteDeviceMax: 960, bitReadDeviceMax: 960, doubleWordDeviceMax: 960, requiredWriteBufferSize: ((960*2) + 30 /*for frame etc*/)},
	"L": {wordDeviceMax: 960, bitWriteDeviceMax: 960, bitReadDeviceMax: 960, doubleWordDeviceMax: 960, requiredWriteBufferSize: ((960*2) + 30 /*for frame etc*/)},
	'R': {wordDeviceMax: 960, bitWriteDeviceMax: 960, bitReadDeviceMax: 960, doubleWordDeviceMax: 960, requiredWriteBufferSize: ((960*2) + 30 /*for frame etc*/)},
});

MCProtocol.prototype.enumOPCQuality = _enum({
	good: { name: 'good', desc: 'Good', value: 0xC0 }, //(192)Good
	goodForced: { name: 'goodForced', desc: 'Good - Local Override, Value Forced', value: 0xD8 }, //(216)Good - Local Override, Value Forced
	bad: { name: 'bad', desc: 'Bad', value: 0x0 }, //(0)Bad
	badConfigErrInServer: { name: 'badConfigErrInServer', desc: 'Bad - Configuration Error in Server', value: 0x4 }, //(4)Bad - Configuration Error in Server
	badNotConnected: { name: 'badNotConnected', desc: 'Bad - Not Connected', value: 0x8 }, //(8)Bad - Not Connected
	badDeviceFailure: { name: 'badDeviceFailure', desc: 'Bad - Device Failure', value: 0xC }, //(12)Bad - Device Failure
	badSensorFailure: { name: 'badSensorFailure', desc: 'Bad - Sensor Failure', value: 0x10 }, //(16)Bad - Sensor Failure
	badLastKnownValPassed: { name: 'badLastKnownValPassed', desc: 'Bad - Last Know Value Passed', value: 0x14 }, //(20)Bad - Last Know Value Passed
	badCommFailure: { name: 'badCommFailure', desc: 'Bad - Comm Failure', value: 0x18 }, //(24)Bad - Comm Failure
	badItemInactive: { name: 'badItemInactive', desc: 'Bad - Item Set InActive', value: 0x1C }, //(28)Bad - Item Set InActive
	uncertain: { name: 'uncertain', desc: 'Uncertain', value: 0x40 }, //(64)Uncertain
	uncertainLastUsableValue: { name: 'uncertainLastUsableValue', desc: 'Uncertain - Last Usable Value - timeout of some kind', value: 0x44 }, //(68)Uncertain - Last Usable Value - timeout of some kind
	uncertainSensorNotAccurate: { name: 'uncertainSensorNotAccurate', desc: 'Uncertain - Sensor not Accurate - outside of limits', value: 0x50 }, //(80)Uncertain - Sensor not Accurate - outside of limits
	uncertainEngUnitsExceeded: { name: 'uncertainEngUnitsExceeded', desc: 'Uncertain - Engineering Units exceeded', value: 0x54 }, //(84)Uncertain - Engineering Units exceeded
	uncertainMultipleSources: { name: 'uncertainMultipleSources', desc: 'Uncertain - Value from multiple sources - with less then required good values', value: 0x58 }, //(88)Uncertain - Value from multiple sources - with less then required good values
	unknown: { name: 'unknown', desc: 'Unknown', value: 0xff }, //(255)Unknown	
});

//https://dl.mitsubishielectric.com/dl/fa/document/manual/plc/sh080008/sh080008x.pdf PG 68
MCProtocol.prototype.enumDeviceCodeSpecQ = _enum({
	SM: {symbol: 'SM', type: 'BIT', notation: 'Decimal', binary: 0x91, ascii: 'SM', description: 'Special relay'},
	SD: {symbol: 'SD', type: 'WORD', notation: 'Decimal', binary: 0xA9, ascii: 'SD', description: 'Special register'},
	TS: {symbol: 'TS', type: 'BIT', notation: 'Decimal', binary: 0xC1, ascii: 'TS', description: 'Timer Contact'},
	TC: {symbol: 'TC', type: 'BIT', notation: 'Decimal', binary: 0xC0, ascii: '', description: 'Timer Coil'},
	TN: {symbol: 'TN', type: 'WORD', notation: 'Decimal', binary: 0xC2, ascii: '', description: 'Timer Current value'},
	STS: {symbol: 'STS', type: 'BIT', notation: 'Decimal', binary: 0xC7, ascii: 'SS', description: 'Retentive timer Contact'},
	STC: {symbol: 'STC', type: 'BIT', notation: 'Decimal', binary: 0xC6, ascii: 'SC', description: 'Retentive timer Coil'},
	STN: {symbol: 'STN', type: 'WORD', notation: 'Decimal', binary: 0xC8, ascii: 'SN', description: 'Retentive timer Current value'},
	CS: {symbol: 'CS', type: 'BIT', notation: 'Decimal', binary: 0xC4, ascii: 'CS', description: 'Counter Contact CS'},
	CC: {symbol: 'CC', type: 'BIT', notation: 'Decimal', binary: 0xC3, ascii: 'CC', description: 'Counter Coil CC'},
	CN: {symbol: 'CN', type: 'WORD', notation: 'Decimal', binary: 0xC5, ascii: 'CN', description: 'Counter Current value CN'},
	SB: {symbol: 'SB', type: 'BIT', notation: 'Hexadecimal', binary: 0xA1, ascii: 'SB', description: 'Link special relay'},
	SW: {symbol: 'SW', type: 'WORD', notation: 'Hexadecimal', binary: 0xB5, ascii: 'SW', description: 'Link special register'},
	DX: {symbol: 'DX', type: 'BIT', notation: 'Hexadecimal', binary: 0xA2, ascii: 'DX', description: 'Direct access input'},
	DY: {symbol: 'DY', type: 'BIT', notation: 'Hexadecimal', binary: 0xA3, ascii: 'DY', description: 'Direct access output'},
	//ZR: {symbol: 'ZR', type: 'WORD', notation: 'Hexadecimal', binary: 0xB0, ascii: 'ZR', description: 'File register'},  << Manual says hex, its actually decimal!!!
	ZR: {symbol: 'ZR', type: 'WORD', notation: 'Decimal', binary: 0xB0, ascii: 'ZR', description: 'File register'},
	X: {symbol: 'X', type: 'BIT', notation: 'Hexadecimal', binary: 0x9C, ascii: 'X*', description: 'Input'},
	Y: {symbol: 'Y', type: 'BIT', notation: 'Hexadecimal', binary: 0x9D, ascii: 'Y*', description: 'Output'},
	M: {symbol: 'M', type: 'BIT', notation: 'Decimal', binary: 0x90, ascii: 'M*', description: 'Internal relay'},
	L: {symbol: 'L', type: 'BIT', notation: 'Decimal', binary: 0x92, ascii: 'L*', description: 'Latch relay'},
	F: {symbol: 'F', type: 'BIT', notation: 'Decimal', binary: 0x93, ascii: 'F*', description: 'Annunciator'},
	V: {symbol: 'V', type: 'BIT', notation: 'Decimal', binary: 0x94, ascii: 'V*', description: 'Edge relay'},
	B: {symbol: 'B', type: 'BIT', notation: 'Hexadecimal', binary: 0xA0, ascii: 'B*', description: 'Link relay'},
	D: {symbol: 'D', type: 'WORD', notation: 'Decimal', binary: 0xA8, ascii: 'D*', description: 'Data register'},
	W: {symbol: 'W', type: 'WORD', notation: 'Hexadecimal', binary: 0xB4, ascii: 'W*', description: 'Link register'},
	Z: {symbol: 'Z', type: 'WORD', notation: 'Decimal', binary: 0xCC, ascii: 'Z*', description: 'Index register'},
	R: {symbol: 'R', type: 'WORD', notation: 'Decimal', binary: 0xAF, ascii: 'R*', description: 'File register'},
	//D: {symbol: 'D', type: 'WORD', notation: 'Decimal', binary: 0xA8, ascii: 'D*', description: 'Extended data register*4'},
	//W: {symbol: 'W', type: 'WORD', notation: 'Hexadecimal', binary: 0xB4, ascii: 'W*', description: 'Extended link register*4'},	
});
MCProtocol.prototype.enumDeviceCodeSpecR = _enum({
	SM: {symbol: 'SM', type: 'BIT', notation: 'Decimal', binary: 0x0091, ascii: 'SM**', description: 'Special relay'},
	SD: {symbol: 'SD', type: 'WORD', notation: 'Decimal', binary: 0x00A9, ascii: 'SD**', description: 'Special register'},
	TS: {symbol: 'TS', type: 'BIT', notation: 'Decimal', binary: 0x00C1, ascii: 'TS**', description: 'Timer Contact'},
	TC: {symbol: 'TC', type: 'BIT', notation: 'Decimal', binary: 0x00C0, ascii: 'TC**', description: 'Timer Coil'},
	TN: {symbol: 'TN', type: 'WORD', notation: 'Decimal', binary: 0x00C2, ascii: 'TN**', description: 'Timer Current value'},
	LTS: {symbol: 'LTS', type: 'BIT', notation: 'Decimal', binary: 0x0051, ascii: 'LTS*', description: 'Long timer, Contact'},
	LTC: {symbol: 'LTC', type: 'BIT', notation: 'Decimal', binary: 0x0050, ascii: 'LTC*', description: 'Long timer, Coil'},
	LTN: {symbol: 'LTN', type: 'DWORD', notation: 'Decimal', binary: 0x0052, ascii: 'LTN*', description: 'Long timer, Current value'},
	STS: {symbol: 'STS', type: 'BIT', notation: 'Decimal', binary: 0x00C7, ascii: 'STS*', description: 'Retentive timer Contact'},
	STC: {symbol: 'STC', type: 'BIT', notation: 'Decimal', binary: 0x00C6, ascii: 'STC*', description: 'Retentive timer Coil'},
	STN: {symbol: 'STN', type: 'WORD', notation: 'Decimal', binary: 0x00C8, ascii: 'STN*', description: 'Retentive timer Current value'},
	LSTS: {symbol: 'LSTS', type: 'BIT', notation: 'Decimal', binary: 0x0059, ascii: 'LSTS', description: 'Long retentive timer, Contact'},
	LSTC: {symbol: 'LSTC', type: 'BIT', notation: 'Decimal', binary: 0x0058, ascii: 'LSTC', description: 'Long retentive timer, Coil'},
	LSTN: {symbol: 'LSTN', type: 'DWORD', notation: 'Decimal', binary: 0x005A, ascii: 'LSTN', description: 'Long retentive timer, Current value'},
	CS: {symbol: 'CS', type: 'BIT', notation: 'Decimal', binary: 0x00C4, ascii: 'CS**', description: 'Counter Contact CS'},
	CC: {symbol: 'CC', type: 'BIT', notation: 'Decimal', binary: 0x00C3, ascii: 'CC**', description: 'Counter Coil CC'},
	CN: {symbol: 'CN', type: 'WORD', notation: 'Decimal', binary: 0x00C5, ascii: 'CN**', description: 'Counter Current value CN'},
	LCS: {symbol: 'LCS', type: 'BIT', notation: 'Decimal', binary: 0x0055, ascii: 'LCS*', description: 'Long counter, Contact'},
	LCC: {symbol: 'LCC', type: 'BIT', notation: 'Decimal', binary: 0x0054, ascii: 'LCC*', description: 'Long counter, Coil'},
	LCN: {symbol: 'LCN', type: 'DWORD', notation: 'Decimal', binary: 0x0056, ascii: 'LCN*', description: 'Long counter, Current value'},
	SB: {symbol: 'SB', type: 'BIT', notation: 'Hexadecimal', binary: 0x00A1, ascii: 'SB**', description: 'Link special relay'},
	SW: {symbol: 'SW', type: 'WORD', notation: 'Hexadecimal', binary: 0x00B5, ascii: 'SW**', description: 'Link special register'},
	DX: {symbol: 'DX', type: 'BIT', notation: 'Hexadecimal', binary: 0x00A2, ascii: 'DX**', description: 'Direct access input'},
	DY: {symbol: 'DY', type: 'BIT', notation: 'Hexadecimal', binary: 0x00A3, ascii: 'DY**', description: 'Direct access output'},
	LZ: {symbol: 'LZ', type: 'DWORD', notation: 'Decimal', binary: 0x0062, ascii: 'LZ**', description: 'Long index register'},
	ZR: {symbol: 'ZR', type: 'WORD', notation: 'Hexadecimal', binary: 0x00B0, ascii: 'ZR**', description: 'File register'},	
	Z: {symbol: 'Z', type: 'WORD', notation: 'Decimal', binary: 0x00CC, ascii: 'Z***', description: 'Index register'},
	R: {symbol: 'R', type: 'WORD', notation: 'Decimal', binary: 0x00AF, ascii: 'R***', description: 'File register'},
	X: {symbol: 'X', type: 'BIT', notation: 'Hexadecimal', binary: 0x009C, ascii: 'X***', description: 'Input'},
	Y: {symbol: 'Y', type: 'BIT', notation: 'Hexadecimal', binary: 0x009D, ascii: 'Y***', description: 'Output'},
	M: {symbol: 'M', type: 'BIT', notation: 'Decimal', binary: 0x0090, ascii: 'M***', description: 'Internal relay'},
	L: {symbol: 'L', type: 'BIT', notation: 'Decimal', binary: 0x0092, ascii: 'L***', description: 'Latch relay'},
	F: {symbol: 'F', type: 'BIT', notation: 'Decimal', binary: 0x0093, ascii: 'F***', description: 'Annunciator'},
	V: {symbol: 'V', type: 'BIT', notation: 'Decimal', binary: 0x0094, ascii: 'V***', description: 'Edge relay'},
	B: {symbol: 'B', type: 'BIT', notation: 'Hexadecimal', binary: 0x00A0, ascii: 'B***', description: 'Link relay'},
	D: {symbol: 'D', type: 'WORD', notation: 'Decimal', binary: 0x00A8, ascii: 'D***', description: 'Data register'},
	W: {symbol: 'W', type: 'WORD', notation: 'Hexadecimal', binary: 0x00B4, ascii: 'W***', description: 'Link register'},
});

MCProtocol.prototype.enumDeviceCodeSpec1E = _enum({
	X: {symbol: 'X', type: 'BIT', notation: 'Hexadecimal', binary: 0x5820, ascii: 'X ', description: 'Input'},
	Y: {symbol: 'Y', type: 'BIT', notation: 'Hexadecimal', binary: 0x5920, ascii: 'Y ', description: 'Output'},
	M: {symbol: 'M', type: 'BIT', notation: 'Decimal', binary: 0x4D20, ascii: 'M ', description: 'Internal relay'},
	L: {symbol: 'L', type: 'BIT', notation: 'Decimal', binary: 0x4D20, ascii: 'M ', description: 'Internal relay'},
	S: {symbol: 'S', type: 'BIT', notation: 'Decimal', binary: 0x4D20, ascii: 'M ', description: 'Internal relay'},
	F: {symbol: 'F', type: 'BIT', notation: 'Decimal', binary: 0x4620, ascii: 'F ', description: 'Annunciator'},
	B: {symbol: 'B', type: 'BIT', notation: 'Hexadecimal', binary: 0x4220, ascii: 'B ', description: 'Link relay'},
	TN: {symbol: 'TN', type: 'WORD', notation: 'Decimal', binary: 0x544E, ascii: 'TN', description: 'Timer Current value'},
	TS: {symbol: 'TS', type: 'BIT', notation: 'Decimal', binary: 0x5453, ascii: 'TS', description: 'Timer Contact'},
	TC: {symbol: 'TC', type: 'BIT', notation: 'Decimal', binary: 0x5443, ascii: 'TC', description: 'Timer Coil'},
	CN: {symbol: 'CN', type: 'WORD', notation: 'Decimal', binary: 0x434E, ascii: 'CN', description: 'Counter Current value'},
	CS: {symbol: 'CS', type: 'BIT', notation: 'Decimal', binary: 0x4353, ascii: 'CS', description: 'Counter Contact'},
	CC: {symbol: 'CC', type: 'BIT', notation: 'Decimal', binary: 0x4343, ascii: 'CC', description: 'Counter Coil'},
	D: {symbol: 'D', type: 'WORD', notation: 'Decimal', binary: 0x4420, ascii: 'D ', description: 'Data register'},
	W: {symbol: 'W', type: 'WORD', notation: 'Hexadecimal', binary: 0x5720, ascii: 'W ', description: 'Link register'},
	R: {symbol: 'R', type: 'WORD', notation: 'Decimal', binary: 0x5220, ascii: 'R ', description: 'File register'},
	});
	
MCProtocol.prototype.enumDeviceCodeSpecL = MCProtocol.prototype.enumDeviceCodeSpecQ;
//MCProtocol.prototype.enumDeviceCodeSpec = MCProtocol.prototype.enumDeviceCodeSpecQ;//default to Q/L series

MCProtocol.prototype.enumDataTypes = _enum({
	REAL: { name: "REAL", dataLength: 4, badValue: 0.0 },
	FLOAT: { name: "FLOAT", dataLength: 4, badValue: 0.0 },
	DWORD: { name: "DWORD", dataLength: 4, badValue: 0 },
	DINT: { name: "DINT", dataLength: 4, badValue: 0 },
	WORD: { name: "WORD", dataLength: 2, badValue: 0 },
	UINT: { name: "UINT", dataLength: 2, badValue: 0 },
	INT: { name: "INT", dataLength: 2, badValue: 0 },
	STR: { name: "STR", dataLength: 1, badValue: '' },
	CHAR: { name: "CHAR", dataLength: 1, badValue: '' },
	BYTE: { name: "BYTE", dataLength: 1, badValue: 0 },
	BIT: { name: "BIT", dataLength: 1, badValue: false },
});


MCProtocol.prototype.enumSendResult = _enum({
	unknown: 0,
	notSent: -1,
	queueFull: -2,
	badRequest: -3,
	sent: 1,
	queued: 2,
});

function decimalToHexString(number) {
	if (number < 0) {
		number = 0xFFFFFFFF + number + 1;
	}

	return "0x" + number.toString(16).toUpperCase();
}

function PLCPacket() {
	this.seqNum = undefined;				// Made-up sequence number to watch for.  
	this.itemList = undefined;  			// This will be assigned the object that details what was in the request.  
	this.reqTime = undefined;
	this.sent = false;						// Have we sent the packet yet?
	this.rcvd = false;						// Are we waiting on a reply?
	this.timeoutError = undefined;			// The packet is marked with error on timeout so we don't then later switch to good data. 
	this.timeout = undefined;				// The timeout for use with clearTimeout()
	this.isWritePacket = false; 
	this.isReadPacket = false;		
	this.command = undefined;
	this.subCommand = undefined;		 
	this.subHeader = undefined;
}


function PLCReadResult(TAG, addr, quality, timeTaken, value, valueType) {
	this.isGood = isQualityOK(quality);
	this.quality = quality;
	this.TAG = TAG;
	this.addr = addr;
	this.timeTaken = timeTaken;
	this.timeStamp = Date.now();
	this.value = value;//TODO: consider sending clone?
	this.valueType = valueType;
}

function PLCWriteResult(TAG, addr, quality, timeTaken) {
	this.isGood = isQualityOK(quality);
	this.quality = quality;
	this.TAG = TAG;
	this.addr = addr;
	this.timeTaken = timeTaken;
	this.timeStamp = Date.now();
}

function PLCItem(owner) { // Object
	this.owner = owner;
	this.initialised = false;

	// MC only
	this.areaMCCode = undefined;
	this.bitNative = undefined;
	this.startRegister = undefined;
	this.byteLengthWrite = undefined;

	// Save the original address
	this.addr = undefined;
	this.useraddr = undefined;

	// First group is properties to do with PLC item - these alone define the address.
	this.deviceCode = undefined;
	this.datatype = undefined;
	this.bitOffset = undefined;
	this.byteOffset = undefined;
	this.offset = undefined;
	this.arrayLength = undefined;
	this.totalArrayLength = undefined;



	this.maxWordLength1E = function (subHeader) {
		/* PG 468 */		
		var plcType = this.plcType;
		switch (subHeader) {
			case 0x00:	// Batch read Bit units 256 points (4 bits per WD... 256/4=64 WDs)
				if(plcType == "A" && this.deviceCode == "X") //
					return 32; //*1 For ACPU ... If only X is specified, the number of points processed per one communication will be one half the value
				return 64;
			case 0x01:	// Batch read Word units, Bit device 128 words (2048 points), Word device 256 points
				if(this.isBitDevice()){
					return 128; //Bit device 128 words (2048 points)
				} else {
					return 255;//256; //Word device 256 points but as the send data for this element is BYTE, 256 will cause overflow. We could handle this but its easier to just reduce maxsize by 1
				}
			case 0x02:	// Batch write Bit units 256 points (4 bits per WD... 256/4=64 WDs)
				if(plcType == "A" && this.deviceCode == "X") //
					return 32; //*1 For ACPU ... If only X is specified, the number of points processed per one communication will be one half the value
				return 64;
			case 0x03:	// Batch write "Word units  Bit device 40 words (640 points)" / "Word device 256 points"
				if(plcType == "A" && this.deviceCode == "X") //
					return 20; //*1 For ACPU ... If only X is specified, the number of points processed per one communication will be one half the value
				return 40;
			case 0x17:	// Extended file register Batch read 256 points
				return 256;
			case 0x18:	// Extended file register Batch write 256 points
				return 256;
			default:
				outputLog('Failed to find a match for 1E subheader ' + subHeader + ' possibly because that function is not supported yet.', "WARN");
				return undefined;
		}

	}

	this.maxWordLength = function () {
		/* PG87, 464
		Target				Word Device					Bit Device														Double Word Device
		A series 			1 to 64 points 			1 to 32 words (1 to 512 points)
		QnA						1 to 480 points			1 to 480 words (1 to 7680 points)
		Q/L/iQR				1 to 960 points 		1 to 960 words (1 to 15360 points) 		1 to 960 words (LCN: 1 to 480 points) (LTN, LSTN: 1 to 240 points)
		*/	
		
		if(this.frame == "1E"){
			var subHeader = this.subHeader;
			return this.maxWordLength1E(subHeader);
		} else {
			try {
				var maxWordLengthSpec;	
				var command = this.command;
				var subCommand = this.subCommand;
				var filteredKey = MCProtocol.prototype.enumMaxWordLength.keys.filter(function (key) {
					let item = MCProtocol.prototype.enumMaxWordLength[key];
					return item.command == command && item.subCommand == subCommand;
				});
				maxWordLengthSpec = MCProtocol.prototype.enumMaxWordLength[filteredKey];
				var deviceType = this.deviceCodeSpec.type + "Device";

				if(maxWordLengthSpec && maxWordLengthSpec[deviceType] && maxWordLengthSpec[deviceType][this.plcType] ){
					return maxWordLengthSpec[deviceType][this.plcType];
				} else {
					throw new Error(`Failed to find a max device count for frame '${this.frame}' command '${command}', subCommand '${subCommand}' possibly because that function is not supported yet.`);
				}
			} catch (error) {
				outputLog(`Error: ${error}`, "ERROR");
			}
		}
		return undefined;

	}


	this.dataTypeByteLength = function () {
		if (typeof (this.deviceCode) === 'undefined') {
			return 1;
		}

		let dt = MCProtocol.prototype.enumDataTypes[this.datatype];
		if (dt) {
			return dt.dataLength;
		} else {
			outputLog(`Failed to find a match for '${this.addr}' possibly because the data type '${this.datatype}' is not supported yet.`, "WARN");
			return undefined;
		}

	}


	// These next properties can be calculated from the above properties, and may be converted to functions.
	this.dtypelen = undefined;
	this.multidtypelen = undefined; // multi-datatype length.  Different than dtypelen when requesting a timer preset, for example, which has width two but dtypelen of 2.
	this.areaMCCode = undefined;
	this.byteLength = undefined;
	this.byteLengthWithFill = undefined;

	// Note that read transport codes and write transport codes will be the same except for bits which are read as bytes but written as bits
	this.readTransportCode = undefined;
	this.writeTransportCode = undefined;

	// // This is where the data can go that arrives in the packet, before calculating the value.  
	// this.byteBuffer = undefined;//new Buffer(8192); //now initialised to correct size - when needed
	// this.writeBuffer = undefined;//new Buffer(8192); //now initialised to correct size - when needed

	// // We use the "quality buffer" to keep track of whether or not the requests were successful.  
	// // Otherwise, it is too easy to lose track of arrays that may only be partially complete.  
	// this.qualityBuffer = undefined;//new Buffer(8192); //now initialised to correct size - when needed
	// this.writeQualityBuffer = undefined;//new Buffer(8192); //now initialised to correct size - when needed

	// This is where the data can go that arrives in the packet, before calculating the value.  
	this.byteBuffer = Buffer.alloc(8192); 
	this.writeBuffer = Buffer.alloc(8192); 

	// We use the "quality buffer" to keep track of whether or not the requests were successful.  
	// Otherwise, it is too easy to lose track of arrays that may only be partially complete.  
	this.qualityBuffer = Buffer.alloc(8192); 
	this.writeQualityBuffer = Buffer.alloc(8192); 


	// Then we have item properties
	this.value = undefined;
	this.writeValue = undefined;
	this.valid = false;
	this.lastError = undefined;
	this.frame = undefined;
	this.plcType = undefined;


	// Then we have result properties
	this.part = undefined;
	this.maxPart = undefined;

	// Block properties
	this.isOptimized = false;
	this.resultReference = undefined;
	this.itemReference = undefined;

	this.isWORDDevice = function() {
		return _isWORDDevice(this);
	}
	function _isWORDDevice(plcitem) {
		return plcitem.deviceCodeSpec.type == 'WORD';
	}
	this.isDWORDDevice = function() {
		return _isDWORDDevice(this);
	}
	function _isDWORDDevice(plcitem) {
		return plcitem.deviceCodeSpec.type == 'DWORD';
	}
	this.isBitDevice = function () {
		return _isBitDevice(this);
	}
	function _isBitDevice(plcitem) {
		return plcitem.deviceCodeSpec.type == 'BIT';
	}

	this.getDeviceCodeSpec = function(){
		var theItem = this;
		
		if(theItem.owner && theItem.owner.enumDeviceCodeSpec){
			return theItem.owner.enumDeviceCodeSpec;
		}
		
		if(theItem.enumDeviceCodeSpec){
			return theItem.enumDeviceCodeSpec;
		}

		if (typeof (theItem.plcType) === 'undefined') {
			theItem.enumDeviceCodeSpec = MCProtocol.prototype.enumDeviceCodeSpecQ;//default to Q/L series
		} else {			
			theItem.enumDeviceCodeSpec = MCProtocol.prototype['enumDeviceCodeSpec' + self.plcType];
		}
		
		if (typeof (theItem.frame) === 'undefined') {
			//
		} else if(theItem.frame.toUpperCase() == '1E'){
			theItem.enumDeviceCodeSpec = MCProtocol.prototype.enumDeviceCodeSpec1E;
		}
		return theItem.enumDeviceCodeSpec;
	}

	this.init = function _stringToMCAddr(addr, TAG, octalInputOutput, frame, plcType, writeValue) {
		"use strict";
		var theItem = this;
		var matches, postDotNumeric, forceBitDtype;

		// Save arguments for later use and reference
		theItem.addr = addr;
		theItem.useraddr = TAG ? TAG : addr;
		theItem.frame = frame;
		theItem.plcType = plcType;

		//initialsiation
		theItem.initError = "";
		theItem.initialised = false;
		theItem.initTime = Date.now();
		theItem.writeValue = writeValue;


		if (TAG === '_COMMERR') {
			// Special-case for communication error status - this variable returns true when there is a communications error 
			theItem.initError = "_COMMERR";
			return false;
		}

		if (!addr) {
			theItem.initError = "addr parameter is empty";
			//outputLog("Error - addr is empty.");
			return false;
		}
		//breakdown the address format [DS] DEV [DT] DA [.BIT] [,CNT] ...  
		/*
		[1] DS	- digit specifier (e.g. K4)    					[optional]
		[2] DEV - Device (Y|X|D|F|W|B|R|etc)
		[3] DT 	- data type (REAL|FLOAT|STR|DWORD|DINT) [optional]
		[4] DA 	- Device Address
		[5] BIT - bit numbeer    												[optional]
		[6] CNT - count of items     										[optional]
		*/
		try {
			addr = addr.toUpperCase();
			var allowedDigitSpecs = "K2|K4|K8";
			//var allowedDeviceTypes = MCProtocol.prototype.enumDeviceCodeSpec.keys.join("|");
			var deviceCodeSpec = this.getDeviceCodeSpec();
			var allowedDeviceTypes = deviceCodeSpec.keys.join("|");
			var allowedDataTypes = MCProtocol.prototype.enumDataTypes.keys.join("|");
			var AltAddressStyle = false; //Alt style combines DS and DT at position [1] e.g. [DS/DT] DEV DA [.BIT] [,CNT]
			var strRegex = undefined;
			if(AltAddressStyle)
				strRegex = `(${allowedDigitSpecs}|${allowedDataTypes})?(${allowedDeviceTypes})(\\w+)(?:\\.?)?(.?)?(?:,)?(\\w+)?(?::)?({.*})?`;
			else
				strRegex = `(${allowedDigitSpecs})?(${allowedDeviceTypes})(${allowedDataTypes})?(\\w+)(?:\\.?)?(.?)?(?:,)?(\\w+)?(?::)?({.*})?`;
				//(K2|K4|K8)?(SM|SD|TS|TC|TN|STS|STC|STN|CS|CC|CN|SB|SW|DX|DY|ZR|X|Y|M|L|F|V|B|D|W|Z|R)(REAL|FLOAT|DWORD|DINT|WORD|UINT|INT|STR|CHAR|BYTE|BIT)?(\w+)(?:\.?)?(.?)?(?:,)?(\w+)?(?::)?({.*})?
			
			outputLog(`Matching address '${addr}' to regex '${strRegex}'.`, "DEBUG");

			var matches = addr.match(strRegex);
			if (!matches) {
				throw new Error(`Unable to match addr '${addr} to a valid config`);
			}
			if (matches[0] != addr) {
				throw new Error(`addr is invalid`);
			}
			var spec;
			if(AltAddressStyle)
				spec = {
					dataType: matches[1] ? matches[1] : "", //e.g. K4 | DWORD | STR etc
					deviceCode: matches[2], //e.g. Y | X | D | M 
					deviceNo: matches[3], //e.g. 1000 | FF1 | E1A etc
					bitNo: (!matches[4] || matches[4] == ",") ? "" : matches[4], //0 ~ F
					deviceCount: matches[5] ? matches[5] : 1,
				}
			else
				spec = {
					digitSpec: matches[1] ? matches[1] : "", //e.g. K4
					deviceCode: matches[2], //e.g. Y | X | D | M 
					dataType: matches[3] ? matches[3] : "", //e.g. DWORD | STR etc
					deviceNo: matches[4], //e.g. 1000 | FF1 | E1A etc
					bitNo: (!matches[5] || matches[5] == ",") ? "" : matches[5], //0 ~ F
					deviceCount: matches[6] ? matches[6] : 1,
					options: (matches[7]) ? JSON.parse(matches[7].replace(/(['"])?([a-z0-9A-Z_]+)(['"])?:/g, '"$2": ')) || {} : {}
				}

			outputLog(`${addr} == ${util.format(spec)}`, "DEBUG");

			//determine the device area
			theItem.digitSpec = spec.digitSpec;
			theItem.datatype = spec.dataType; // eg "DINT"
			theItem.deviceCode = spec.deviceCode;
			theItem.prefix = theItem.digitSpec + theItem.deviceCode + theItem.datatype;
			theItem.options = spec.options;

			//get device number (if X / Y, then convert HEX to DEC)
			let devNo = spec.deviceNo, radix = 10;
			//theItem.deviceCodeSpec = MCProtocol.prototype.enumDeviceCodeSpec[theItem.deviceCode];
			theItem.deviceCodeSpec = deviceCodeSpec[theItem.deviceCode];
			switch (theItem.deviceCodeSpec.notation) {
				case 'Decimal':
					radix = 10;
					break;
				case 'Hexadecimal':
					radix = 16;
					devNo = "0x" + spec.deviceNo;
					break;
				case 'Octal':
					radix = 8;
					break;
				default:
					throw new Error(`Device notation '${theItem.deviceCodeSpec.notation}' is not supported.`);
			} 


			if(!isNumeric(devNo)){
				throw new Error(`Device Number '${spec.deviceNo}' is not numeric.`);
			}
			theItem.offset = parseInt(spec.deviceNo, radix);
			if (isNaN(theItem.offset)) {
				throw new Error(`Device Number '${spec.deviceNo}' is NG.`);
			}

			//determine BIT  
			if (spec.bitNo != "") {
				postDotNumeric = parseInt("0x" + spec.bitNo);
			}

			//determine Array Len
			theItem.arrayLength = parseInt(spec.deviceCount);
			if (isNaN(theItem.arrayLength)) {
				throw new Error(`Count '${spec.deviceCount}' is invalid`);
			}

		} catch (error) {
			theItem.initError = `Unable to parse address '${addr}'.  ${error}`;
			//outputLog(`Unable to parse address '${addr}'.  Error : ${error}`);
			return false;
		}

		theItem.areaMCCode = theItem.deviceCodeSpec.binary;

		if (!theItem.areaMCCode) {
			theItem.initError = 'Failed to find a match for ' + theItem.deviceCode + ' possibly because that type is not supported yet.';
			//outputLog('Failed to find a match for ' + theItem.deviceCode + ' possibly because that type is not supported yet.');
			return false;
		}

		if(theItem.digitSpec == "K2"){
			theItem.datatype = "BYTE";
		} else if(theItem.digitSpec == "K4"){
			theItem.datatype = "INT";
		} else if(theItem.digitSpec == "K8"){
			theItem.datatype = "DINT";
		}

		if (theItem.datatype == "") {
			if (theItem.isBitDevice()) {
				theItem.datatype = "BIT";
			}else{
				theItem.datatype = "INT";
			}
		}
		if (theItem.deviceCode === "CN" && theItem.offset >= 200) {
			theItem.datatype = "DINT";
		}
		let dts = MCProtocol.prototype.enumDataTypes;
		let dt = dts[theItem.datatype];
		switch (dt.name) {
			case dts.REAL.name:
			case dts.FLOAT.name:
			case dts.DINT.name:
			case dts.DWORD.name:
				// These are the double-byte types
				theItem.remainder = 0;
				theItem.dtypelen = 4;
				theItem.multidtypelen = 4;
				theItem.requestOffset = theItem.offset;
				break;
			case dts.WORD.name:
			case dts.INT.name:
			case dts.UINT.name:
				theItem.remainder = 0;
				theItem.dtypelen = 2;
				theItem.multidtypelen = 2;
				if (typeof (postDotNumeric) !== 'undefined') {
					theItem.datatype = 'BIT';
					theItem.bitOffset = postDotNumeric;
					theItem.remainder = theItem.bitOffset % 16;//bug fix.  If D1000.1,16 is requested, we need to get 2 WDs as the addr range is D1000.1 ~ D1001.1
				}
				if (theItem.deviceCode === "CN" && theItem.offset >= 200) {
					theItem.dtypelen = 4;
					theItem.multidtypelen = 4;
				}
				theItem.requestOffset = theItem.offset;
				break;

			case dts.CHAR.name:
			case dts.STR.name:
				// These are the double-byte types
				theItem.datatype = "CHAR";
				theItem.multidtypelen = 1;
				theItem.remainder = 0;
				theItem.requestOffset = theItem.offset;
				theItem.dtypelen = 1;
				break;
			case dts.BIT.name:
				//theItem.deviceCode = theItem.prefix;
				theItem.datatype = "BIT";
				theItem.multidtypelen = 2;
				theItem.remainder = theItem.offset % 16;
				theItem.requestOffset = theItem.offset - theItem.remainder;
				theItem.dtypelen = 2;  // was 1, not sure why, we read 1 word at a time. SMc-If we request X0,2 we get a 1byte reply!
				theItem.bitNative = theItem.isBitDevice();
				break;
			default:
				theItem.initError = 'Failed to find a match for ' + theItem.addr + ' possibly because type is not supported yet.';
				//outputLog('Failed to find a match for ' + theItem.addr + ' possibly because ' + theItem.prefix + ' type is not supported yet.');
				return false;

		}

		if (forceBitDtype) {
			theItem.datatype = "BIT";
		}



		if (theItem.datatype === 'BIT') {
			theItem.wordLength = Math.ceil((theItem.remainder + theItem.arrayLength) / 16);  // used tadd request offset here but not right
			// if(!theItem.bitNative){
			// 	var wdOverflow = ((theItem.bitOffset + theItem.arrayLength) % 16) > 0;
			// 	if(wdOverflow)
			// 	theItem.wordLength += 1;//need to consider max req len!
			// }
		} else {
			theItem.wordLength = Math.ceil(theItem.arrayLength * theItem.dataTypeByteLength() / 2);
		}
		if (isNaN(theItem.wordLength)) {
			//console.log("theItem.byteLength is NAN");
			theItem.initError = "wordLength is NAN!";
		}
		theItem.byteLength = theItem.wordLength * 2;
		if (isNaN(theItem.byteLength)) {
			//console.log("theItem.byteLength is NAN");
			theItem.initError = "byteLength is NAN!";
		}

		theItem.byteLength = theItem.wordLength*2;
		theItem.byteLengthWrite = (theItem.bitNative) ? Math.ceil(theItem.arrayLength/2) : theItem.byteLength;
		theItem.totalArrayLength = theItem.arrayLength;

		// Counter check - can't think of a better way to handle this.
		if (theItem.deviceCode === "CN" && theItem.requestOffset < 200 && (theItem.requestOffset + theItem.arrayLength > 200)) {
			theItem.initError = "You can't have a counter array that crosses the 200-point boundary.";
			//outputLog(theItem.initError);
			return false;
		}

		let writeOperation = writeValue == undefined ? false : true;
		if (frame === '1E') {

			// Hard code the header.  Note that for bit devices, we use the less-efficient, but easier to program, bit device read.
			if (theItem.bitNative) {
				if (writeOperation) {
					theItem.subHeader = 0x02; //Batch Write BIT units
				} else {
					theItem.subHeader = 0x01; // For now we read words. (MC command 0x00 is bit read)
				}
			} else {
				if (writeOperation) {
					theItem.subHeader = 0x03; //batch write WORD units
				} else {
					theItem.subHeader = 0x01; //batch read WORD units
				}
			}
		} else {
			// * Command
			theItem.command = (writeOperation ? 0x1401 : 0x0401);
			if (theItem.bitNative) {
				if (writeOperation)
					theItem.subCommand = (plcType == MCProtocol.prototype.enumPLCTypes.R.name ? 0x0003 : 0x0001);
				else	//reading - use subcommand 0/2 (batch read words) instead of 1/3 (batch read bits)
					theItem.subCommand = (plcType == MCProtocol.prototype.enumPLCTypes.R.name ? 0x0002 : 0x0000);
			} else {
				theItem.subCommand = (plcType == MCProtocol.prototype.enumPLCTypes.R.name ? 0x0002 : 0x0000);//subcommand 0 or 2 (batch read/write words)
			}
		}

		theItem.initialised = theItem.initError == "";
		return theItem.initialised;
	}

	this.updateSeqNum = function(seqNum){
		var self = this;
		self.seqNum = seqNum;
		if(self.frame == "4E"){
			self.buffer.writeUInt16LE(seqNum,2); // SEQ
		}
	}

	this.toBuffer =	function _MCAddrToBuffer(isAscii, frame, plcType, seqNum, network, PCStation, PLCStation, PLCModuleNo) {
		var self = this;
		var writeOperation = self.writeValue === undefined ? false : true;
		var writeLength, MCCommand = Buffer.alloc(2500);
		self.buffer = undefined;
		self.isAscii = isAscii;
		self.frame = frame;
		self.plcType = plcType;
		self.bufferized = false;
		self.seqNum = seqNum;

		var result = {
			data: undefined,
			subHeader: undefined,
			command: undefined,
			subCommand: undefined
		}
		/*
	
		The MC Buffer for 'D1234,55' is:
						0                             1  
						0  1  2  3  4  5  6  7  8  9  0  1   
		<Buffer 01 ff 0a 00 d2 04 00 00 20 44 37 00>
		
		1E frame... Subheader, PC No., ACPU monitoring timer, Request data
	
		0 - Sub header :  01 = read 
		1 - PC number  :  ff = default or Specify the network module station No.01H to 40H (1 to 64) of the target.
		2 - ACPU mon timer:  0a 00 = 10 Waiting time (unit: 250 ms) ~ 10x250=2.5s (UINT16 - Little Endian (BA))
		4 - Device Number :  d2 04 00 00  = 1234   (UINT32 - Little Endian (DCBA)) 
		8 - Device Area   :  20 44        = 4420 == D area (UINT16 - Little Endian (BA))
		10- Device Count  : 37 00        = 55     == device count (UINT16 - Little Endian (BA))
	
		*/
		
		writeLength = writeOperation ? (self.byteLengthWrite) : 0; 

		if (frame === '1E') {
	
			headerLength = 4;
	
			MCCommand[0] = self.subHeader ;
			MCCommand[1] = 0xff;
	
			if (isAscii) {
				outputLog("We're Ascii", "DEBUG");
				MCCommand.writeUInt16BE(monitoringTime, 2);
			} else {
				outputLog("We're Binary", "DEBUG");
				MCCommand.writeUInt16LE(monitoringTime, 2);
			}
	
			// Write the data type code
			if (isAscii) {
				MCCommand.writeUInt16BE(self.areaMCCode, 4);
			} else {
				MCCommand.writeUInt16LE(self.areaMCCode, 8);
			}
	
			// Write the data request offset
			if (isAscii) {
				if (writeOperation) {
					MCCommand.writeUInt32BE(self.offset, 6);
				} else {
					MCCommand.writeUInt32BE(self.requestOffset, 6);
				}
			} else {
				if (writeOperation) {
					MCCommand.writeUInt32LE(self.offset, 4);
				} else {
					// RequestOffset ensures bit-native types are read as a word
					MCCommand.writeUInt32LE(self.requestOffset, 4);
				}
			}
	
			// Number of elements in request - for single-bit, 16-bit, 32-bit, this is always the number of WORDS
			if (self.bitNative && writeOperation) {
				// set to bit length
				MCCommand.writeUInt8(self.arrayLength, 10);  // fails when asking for >256 items because we call toBuffer() before breaking into "parts"
			} else if (self.bitNative && !writeOperation) {
				MCCommand.writeUInt8(Math.ceil((self.arrayLength + self.remainder) / 16), 10);
			} else {
				// doesn't work with optimized blocks where array length isn't right		MCCommand.writeUInt8(self.arrayLength*self.dataTypeByteLength()/2, 10);
				if (writeOperation) {
					MCCommand.writeUInt8(self.byteLengthWrite / 2, 10);
				} else {
					MCCommand.writeUInt8(self.byteLength / 2, 10);
				}
			}
	
			// Spec says to write 0 here
			MCCommand.writeUInt8(0, 11);
	
			if (writeOperation) {
				//self.prepareWriteData();
				self.writeBuffer.copy(MCCommand, 12, 0, self.byteLengthWrite);
				reqDataLen += writeLength;
			}
	
			//return 1E frame
			result.data = MCCommand.slice(0, 12 + writeLength); 
			self.buffer = result;
			self.bufferized = true;
			outputLog(`MCAddrToBuffer generated the below data for ${self.addr} (frame ${frame}, plcType ${plcType})...`, "TRACE");
			outputLog('        0                             1                             2                 ', "TRACE");
			outputLog('        0  1  2  3  4  5  6  7  8  9  0  1  2  3  4  5  6  7  8  9  0  1  2  3  4  5  ', "TRACE");
			outputLog(result.data, "TRACE")

			return result;
		} else {
			//frame 3E / 4E
	
			if (isAscii) {
				throw new Error("ASCII Mode not implimented for 3E/4E frames");
			}
	
			/*
			4E/3E frame... Subheader, Access route, Request data length, Monitoring timer, Request data
			Subheader The value to be set according to type of message is defined.
				4E frame: Set a serial No.
				3E frame: Fixed value (Request message '5000', Response message 'D000')
				Page 42 Subheader
			Access route 
				Specify the access route. 
				Page 45 ACCESS ROUTE SETTINGS
			Request data length  (UINT16 LE)
				Specify the data length from the monitoring timer --> request data. 
				Page 43 Request data length and response data length
			Monitoring timer  (UINT16 LE 0 or 1~40 = 1=250ms, 40=10s )
				Set the wait time up to the completion of reading and writing processing. 
				Page 43 Monitoring timer
			Request data 
				COMMAND + SUBCOMMAND + DEVICE
				For the request data, set the command that indicates the request content. 
				Refer to "Request data" rows of each command.
				Page 60 COMMANDS AND FUNCTIONS
				* Batch Read Words:  04 01 (00 00 | 02 00)  (Q/L = 00 00, iQR = 02 00)
				* Batch Read Bits:   04 01 (00 01 | 03 00)  (Q/L = 00 00, iQR = 02 00)
				* Batch Write Words: 14 01 (00 00 | 02 00)  (Q/L = 00 00, iQR = 02 00)
				* Batch Write Bits:  14 01 (00 01 | 03 00)  (Q/L = 00 00, iQR = 02 00)
		
		
				3E Q/L example
				0                             1                             2                             3
				0  1  2  3  4  5  6  7  8  9  0  1  2  3  4  5  6  7  8  9  0  1  2  3  4  5  6  7  8  9  0
				50 00 00 ff ff 03 00 0a 00 10 00 01 04 00 00 d2 04 00 A8 37 00
		
				4E Q/L example
				0                             1                             2                             3
				0  1  2  3  4  5  6  7  8  9  0  1  2  3  4  5  6  7  8  9  0  1  2  3  4  5  6  7  8  9  0
				54 00 02 00 00 00 00 ff ff 03 00 0a 00 10 00 01 04 00 00 d2 04 00 A8 37 00
				
				Subheader 4E 0x0054 + serial number + 0x0000 (6b) 1234H (5400 = 4E frame, 0200=2h, 0000 fixed) 
				0: 54 00 34 12 00 00  
		
				Subheader 3E 5000  fixed 
				0: 50 00
		
				access route (5b)- connect to local example net0, pcno ff, 
				4E:6: 00 ff ff 03 00
				3E:2: 00 ff ff 03 00
				* (Byte) Network No ,  Specify the network No. of an access target.
				* (Byte) PC No. (byte) Specify the network module station No. of an access target
				* (UINT16 LE) Request destination module I/O No 
					0000H to 01FFH: Values obtained by dividing the start input/output number by 16
				* (Byte) Request destination module station No. 
					When accessing a multidrop connection station, specify the station No. of an access target module
					00H to 1FH (0 to 31): Station No
					ex. Accessing the connected station (host station) FFH 03H 00H
					
				Req Data length (2b) (UINT16 LE) =  noof bytes from Monitoring timer --> Request data
				4E:11: 0a 00     (10 bytes)
				3E:07: 0a 00     (10 bytes)
		
				Monitoring timer (2b) (0= wait forever, 01H=250ms ~ 28H=40x250=10s )
				13: 10 00  	
		
				Request data (10b Q/L,  12b iQR)
				15: 01 04 00 00 d2 04 00 00 20 44 37 00
		
					Command (4b)
					15: 01 04 00 00 
							01 04 = 0401=read
							00 00 = subcommand 0 (Q/L series)
					
					Device (6b Q/L,  8b iQR)
					19: d2 04 00 A8 37 00
					Q/L (6 bytes)
					(UINT16 LE) - Device Number :  d2 04   = 1234   
					(BYTE)      - Device Number 
					(UINT8)     - Device code   :  A8      = 0xa8 == D area  
					(UINT16 LE) - Device Count  :  37 00   = 55  
					iQ-R (8 bytes)
					(UINT32 LE) - Device Number :  d2 04 00 00  = 1234    
					(UINT16 LE) - Device code   :  A8 00        = 0xA8 == D area  
					(UINT16 LE) - Device Count  :  37 00        = 55  
		
				*/
	
	
			//Subheader: serial number (4E) or fixed (3E) 
			//example 1234H (5400 = 4E frame, 3412=1234h, 0000 fixed) 
			// 0  1  2  3  4  5
			// 54 00 34 12 00 00 
			if (frame === '4E') {
				MCCommand.addByte(0x54); // 4E frame
				MCCommand.addByte(0x00); // 4E frame
				MCCommand.addUint16LE(seqNum); // SEQ
				MCCommand.addUint16LE(0x0); // fixed
				pos = 6;
			} else {
				MCCommand.addByte(0x50); // 3E frame
				MCCommand.addByte(0x00); // 3E frame
				pos = 2;
			}
	
			//access route - connect to local example net0, pcno ff, 
			// 00 ff ff 03 00
			/*
			* (Byte) Network No ,  Specify the network No. of an access target.
			* (Byte) PC No. (byte) Specify the network module station No. of an access target
			* (UINT16 LE) Request destination module I/O No 
				0000H to 01FFH: Values obtained by dividing the start input/output number by 16
				0x03FF = CPU
			* (Byte) Request destination module station No. 
			*/
			let networkNo = network ? network : (this.options.N || 0);
			let stationNo = PCStation ? PCStation : (this.options.S || 0xff);

			MCCommand.addByte(networkNo); // net
			MCCommand.addByte(stationNo); // PC No
			MCCommand.addUint16LE(PLCModuleNo ? PLCModuleNo : 0x3FF); //03ff // Request destination module I/O No //for multidrop/routing
			MCCommand.addByte(PLCStation ? PLCStation : 0); //0x0 // Request destination module station No //for multidrop/routing
			pos += 5;
	
			//Request data length  (UINT16 LE)
			var reqDataLenPos = MCCommand.pointer;
			var reqDataLen = 0;
			//Update Data Length after its understood below - for now, set length as zero
			MCCommand.addUint16LE(0);
			pos += 2;
	
			//Monitoring timer  (0= wait forever, 01H=250ms ~ 28H=40x250=10s )
			MCCommand.addUint16LE(monitoringTime);
			pos += 2;
			reqDataLen += 2;
	
			// //Request data...
			// * Command
			MCCommand.addUint16LE(self.command);
			MCCommand.addUint16LE(self.subCommand);
	
	
			pos += 4;
			reqDataLen += 4;
			// * Device
			/*
				Q/L
				(UINT16 LE) - Device Number :  d2 04   = 1234   
				(BYTE)      - Device Number 
				(UINT8)     - Device code   :  A8      = 0xa8 == D area  
				(UINT16 LE) - Device Count  :  37 00   = 55  
				iQ-R
				(UINT32 LE) - Device Number :  d2 04 00 00  = 1234    
				(UINT16 LE) - Device code   :  A8 00        = 0xA8 == D area  
				(UINT16 LE) - Device Count  :  37 00        = 55  
	
			*/
			// Device Number
			var offset = writeOperation ? self.offset : self.requestOffset;
			MCCommand.addByte(offset & 0xff);
			MCCommand.addByte((offset >> 8) & 0xff);
			MCCommand.addByte((offset >> 16) & 0xff);
			pos += 3;
			reqDataLen += 3;

	
			if (plcType == 'R') {
				MCCommand.addByte((offset >> 24) & 0xff);
				pos += 1;
				reqDataLen += 1;
				}

				
			// Device Code
			if (plcType == 'R') {
				MCCommand.addUint16LE(self.areaMCCode);
				pos += 2;
				reqDataLen += 2;
			} else {
				MCCommand.addByte(self.areaMCCode);
				reqDataLen += 1;
				pos += 1;
			}
	
			//NOTES:
			// 1E Number of elements in request - for single-bit, 16-bit, 32-bit, this is always the number of WORDS
			// 3E,4E Number of elements in request - 
			//    for batch bit read each bit is returned in 1 digit.
			//    for batch word read, this is always the number of WORDS
			if (self.bitNative && writeOperation) {
				MCCommand.addUint16LE(self.arrayLength);// set to bit length
			} else if (self.bitNative && !writeOperation) {
				//for now, we dont use Batch Read Bits function - so we need to request noof WORDs
				MCCommand.addUint16LE(Math.ceil((self.arrayLength + self.remainder) / 16));
			} else {
				if (writeOperation) {
					MCCommand.addUint16LE(self.byteLengthWrite / 2);//noof words
				} else {
					MCCommand.addUint16LE(self.byteLength / 2);//noof words		
				}
			}
			pos += 2;
			reqDataLen += 2;
	
	
			//add write data
			if (writeOperation) {
				//self.prepareWriteData();
				self.writeBuffer.copy(MCCommand, pos, 0, self.byteLengthWrite);
				reqDataLen += writeLength;
			}
	
			//update the Request Data Length
			MCCommand.writeInt16LE(reqDataLen, reqDataLenPos);
	
			//return 3E/4E frame 
			result.data = MCCommand.slice(0, pos + writeLength);   
			outputLog(`MCAddrToBuffer generated the below data for ${self.addr} (frame ${frame}, plcType ${plcType})...`, "TRACE");
			outputLog('        0                             1                             2                 ', "TRACE");
			outputLog('        0  1  2  3  4  5  6  7  8  9  0  1  2  3  4  5  6  7  8  9  0  1  2  3  4  5  ', "TRACE");
			outputLog(result.data, "TRACE");
			self.buffer = result;
			self.bufferized = true;
			return result;
		}
	}

	this.prepareWriteData = function _prepareWriteData() {
		var thePointer, theByte, problem = false;
		var theItem = this;
		var isAscii = theItem.isAscii;

		theByte = 0;
		thePointer = 0; // After length and header

		try {
			
			 //if(!theItem.writeBuffer || !theItem.writeQualityBuffer || !(theItem.writeBuffer.length == theItem.byteLengthWrite)){
			 	theItem.writeBuffer.fill(0) //= new Buffer(theItem.byteLengthWrite+1);
			 	theItem.writeQualityBuffer.fill(0) //= new Buffer(theItem.byteLengthWrite+1);
			 //}
			// if(!theItem.writeBuffer){
			// 	theItem.writeBuffer = new Buffer(theItem.byteLengthWrite);
			// 	theItem.writeQualityBuffer = new Buffer(theItem.byteLengthWrite);
			// }


			if (theItem.arrayLength > 1) {
				// Array value.  
				var bitShiftAmount = theItem.bitOffset;
				var stringNullFound = false;
				for (arrayIndex = 0; arrayIndex < theItem.arrayLength; arrayIndex++) {
					switch (theItem.datatype) {
						case "REAL":
							if (isAscii) {
								theItem.writeBuffer.setFloatBESwap(theItem.writeValue[arrayIndex], thePointer)
							} else {
								theItem.writeBuffer.writeFloatLE(theItem.writeValue[arrayIndex], thePointer);
							}
							break;
						case "DWORD":
							if (isAscii) {
								theItem.writeBuffer.setUInt32BESwap(theItem.writeValue[arrayIndex], thePointer);
							} else {
								theItem.writeBuffer.writeUInt32LE(theItem.writeValue[arrayIndex], thePointer);
							}
							break;
						case "DINT":
							if (isAscii) {
								theItem.writeBuffer.setInt32BESwap(theItem.writeValue[arrayIndex], thePointer);
							} else {
								theItem.writeBuffer.writeInt32LE(theItem.writeValue[arrayIndex], thePointer);
							}
							break;
						case "INT":
							if (isAscii) {
								theItem.writeBuffer.writeInt16BE(theItem.writeValue[arrayIndex], thePointer);
							} else {
								theItem.writeBuffer.writeInt16LE(theItem.writeValue[arrayIndex], thePointer);
							}
							break;
						case "UINT":
						case "WORD":
							if (isAscii) {
								theItem.writeBuffer.writeUInt16BE(theItem.writeValue[arrayIndex], thePointer);
							} else {
								theItem.writeBuffer.writeUInt16LE(theItem.writeValue[arrayIndex], thePointer);
							}
							break;
						case "BIT":
							if (arrayIndex % 2) {
								theByte = theByte | ((theItem.writeValue[arrayIndex] == true) ? 1 : 0);
							} else {
								theByte = theByte | (((theItem.writeValue[arrayIndex] == true) ? 1 : 0) << 4);
							}
							// Maybe not so efficient to do this every time when we only need to do it every 8.  Need to be careful with optimizations here for odd requests.  
							theItem.writeBuffer.writeUInt8(theByte, thePointer);
							//theItem.writeBuffer.writeUInt8(0, thePointer + 1);  // Zero out the pad byte
							//bitShiftAmount++;
							break;
						case "B":
						case "BYTE":
							if (isAscii) {
								if (arrayIndex % 2) {
									theItem.writeBuffer.writeUInt8(theItem.writeValue[arrayIndex], thePointer - 1);
								} else {
									theItem.writeBuffer.writeUInt8(theItem.writeValue[arrayIndex], thePointer + 1);
								}
							} else {
								theItem.writeBuffer.writeUInt8(Math.round(theItem.writeValue[arrayIndex]), thePointer);
							}
							break;
						case "C":
						case "CHAR":
							// Convert to string.  
							if (isAscii) {
								//todo: stop at null
								if (arrayIndex % 2) {
									theItem.writeBuffer.writeUInt8(theItem.writeValue.charCodeAt(arrayIndex), thePointer - 1);
								} else {
									theItem.writeBuffer.writeUInt8(theItem.writeValue.charCodeAt(arrayIndex), thePointer + 1);
								}
							} else {
								var ch = theItem.writeValue.charCodeAt(arrayIndex);
								if (ch > 0 && !stringNullFound)
									theItem.writeBuffer.writeUInt8(ch, thePointer);
								else
									stringNullFound = true;
							}
							break;
						default:
							throw new Error(`Unknown data type '${theItem.datatype}'`);
					}
					if (theItem.datatype == 'BIT') {
						// Increment the pointer "sometimes" - only when we cross byte boundaries, then set to zero as we "AND" things together to build the byte.
						if (arrayIndex % 2) {
							thePointer += 1;
							theByte = 0;
						}
					} else {
						// Add to the pointer every time.  
						thePointer += theItem.dtypelen;
					}
				}
			} else {
				// Single value. 
				switch (theItem.datatype) {
	
					case "REAL":
						if (isAscii) {
							theItem.writeBuffer.setFloatBESwap(theItem.writeValue, thePointer);
						} else {
							theItem.writeBuffer.writeFloatLE(theItem.writeValue, thePointer);
						}
						break;
					case "DWORD":
						if (isAscii) {
							theItem.writeBuffer.setUInt32BESwap(theItem.writeValue, thePointer);
						} else {
							theItem.writeBuffer.writeUInt32LE(theItem.writeValue, thePointer);
						}
						break;
					case "DINT":
						if (isAscii) {
							theItem.writeBuffer.setInt32BESwap(theItem.writeValue, thePointer);
						} else {
							theItem.writeBuffer.writeInt32LE(theItem.writeValue, thePointer);
						}
						break;
					case "INT":
						if (isAscii) {
							theItem.writeBuffer.writeInt16BE(theItem.writeValue, thePointer);
						} else {
							theItem.writeBuffer.writeInt16LE(theItem.writeValue, thePointer);
						}
						break;
					case "WORD":
						if (isAscii) {
							theItem.writeBuffer.writeUInt16BE(theItem.writeValue, thePointer);
						} else {
							theItem.writeBuffer.writeUInt16LE(theItem.writeValue, thePointer);
						}
						break;
					case "BIT":
						if (theItem.bitNative) {
							//e.g. 0x10 = Turn on first bit, turn off 2nd bit. 
							//e.g. 0x01 0x10 = Turn on off 1st bit, turn on 2nd bit. , turn on 3rd bit. turn off 4th bit.
							theItem.writeBuffer.writeUInt8(((theItem.writeValue) ? 0x10 : 0x00), thePointer);  // checked ===true but this caused problems if you write 1
							theItem.writeBuffer.writeUInt8(0x00, thePointer + 1);
							outputLog("Datatype is X writing " + theItem.writeValue + " tpi " + theItem.writeBuffer[0], "DEBUG");
						} else {
							throw new Error(`We don't support writing individual bits of non-native types - write the whole word externally please`);
						}
						break;
					case "B":
					case "BYTE":
						// No support as of yet for signed 8 bit.  This isn't that common.  
						if (isAscii) {
							theItem.writeBuffer.writeUInt8(Math.round(theItem.writeValue), thePointer + 1);
							theItem.writeBuffer.writeUInt8(0, thePointer);
						} else {
							theItem.writeBuffer.writeUInt8(Math.round(theItem.writeValue), thePointer);
						}
						break;
					case "C":
					case "CHAR":
						// No support as of yet for signed 8 bit.  This isn't that common.  
						if (isAscii) {
							theItem.writeBuffer.writeUInt8(String.toCharCode(theItem.writeValue), thePointer + 1);
							theItem.writeBuffer.writeUInt8(0, thePointer);
						} else {
							theItem.writeBuffer.writeUInt8(String.toCharCode(theItem.writeValue), thePointer);
						}
						break;
					default:
						throw new Error(`Unknown data type '${theItem.datatype}'`);
				}
				thePointer += theItem.dtypelen;
			}
	
		} catch (error) {
			theItem.lastError = `Exception preparing the write buffer for item '${theItem.useraddr}': ${error}`;
			outputLog(theItem.lastError, "ERROR");
			problem = true;
		}
		return !problem;
	}


	// And functions...
	this.clone = function () {
		var newObj = new PLCItem(this.owner);
		for (var i in this) {
			if (i == 'clone') 
				continue;
			// if (i == 'qualityBuffer') 
			// 	continue;
			// if (i == 'writeQualityBuffer') 
			// 	continue;
			newObj[i] = this[i];
		}
		newObj._instance = "clone";
		return newObj;
	};


	// Bad value function definition
	this.badValue = function () {
		let dt = MCProtocol.prototype.enumDataTypes[this.datatype];
		if (!dt) {
			outputLog("Unknown data type when figuring out bad value - should never happen.  Should have been caught earlier.  " + this.datatype, "ERROR");
			return 0;
		}
		return dt.badValue;
	}

}

function itemListSorter(a, b) {
	// Feel free to manipulate these next two lines...
	if (a.areaMCCode < b.areaMCCode) { return -1; }
	if (a.areaMCCode > b.areaMCCode) { return 1; }

	// But for byte offset we need to start at 0.  
	if (a.offset < b.offset) { return -1; }
	if (a.offset > b.offset) { return 1; }

	// Then bit offset
	if (a.bitOffset < b.bitOffset) { return -1; }
	if (a.bitOffset > b.bitOffset) { return 1; }

	// Then item length - most first.  This way smaller items are optimized into bigger ones if they have the same starting value.
	if (a.byteLength > b.byteLength) { return -1; }
	if (a.byteLength < b.byteLength) { return 1; }
}

function doNothing(arg) {
	return arg;
}
function binarize(buf) {
	var i, newBuf;
	if (buf && !(buf.length % 2)) {
		newBuf = Buffer.alloc(buf.length / 2);
		for (i = 0; i < buf.length; i += 2) {
			newBuf[i / 2] = parseInt("0x" + buf.toString('ascii', i, i + 2));
			if (isNaN(newBuf[i / 2])) {
				return undefined;
			}
		}
		return newBuf;
	}
	return undefined;
}

function asciize(buf) {
	var i, newBuf;
	if (buf) {
		newBuf = Buffer.alloc(buf.length * 2);
		for (i = 0; i < buf.length; i += 1) {
			newBuf.write(zeroPad(buf[i], 2), i * 2, 2, 'ascii');
		}
		return newBuf;
	}
	return undefined;
}

function zeroPad(num, places) {
	var zero = places - num.toString(16).length + 1;
	return Array(+(zero > 0 && zero)).join("0") + num.toString(16);
}


function _enum(list) {
	list.keys = [];
	//list.values = [];
	for (var key in list) {
		if (key != "keys" && key != "values") {
			let v = list[key] = list[key];
			let t = typeof (v);
			let alt = undefined;
			if (t == "string" || t == "number")
				alt = v;
			else if (t == "object"){
				if(v.hasOwnProperty('value'))
					alt = v.value;
				if(!v.name)
					v.name = key;
			}

			if (alt !== undefined)
				list[alt] = v;

			list.keys.push(key);
			//list.values.push(list[key]);
		}
	}
	list.toString = function (intVal) {
		return list[intVal];
	}
	return Object.freeze(list);
}

function isNumeric(n) {
	return !isNaN(parseFloat(n)) && isFinite(n);
}