/*
MIT License

Copyright (c) 2019, 2020 Steve-Mcl

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. 
*/

module.exports = function(RED) {
  var connection_pool = require("../connection_pool.js");
  function isNumeric(n) {
    return !isNaN(parseFloat(n)) && isFinite(n);
  }
  function mcRead(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name;
    this.topic = config.topic;
    this.connection = config.connection;
    this.address = config.address || ""; //address
    this.addressType = config.addressType || "str";
    this.outputFormat = config.outputFormat || 0;
    this.errorHandling = config.errorHandling;
    this.outputs = config.errorHandling === "output2" ? 2 : 1;//1 output pins if throw or msg.error, 2 outputs if errors to go to seperate output pin
    this.logLevel = RED.settings.logging.console.level;
    this.connectionConfig = RED.nodes.getNode(this.connection);
    var context = this.context();
    var node = this;
    node.busy = false;
    //node.busyMonitor;
    node.busyTimeMax = 1000; //Initial value, will be updated bt selected connection
    //var mcprotocol = require('../mcprotocol.js');
    if (this.connectionConfig) {
      var options = Object.assign({}, node.connectionConfig.options);
      options.logLevel = this.logLevel;
      node.connection = connection_pool.get(
        this.connectionConfig.port,
        this.connectionConfig.host,
        options
      );
      if(options.timeout && isNumeric(options.timeout)) node.busyTimeMax = parseInt(options.timeout);
      
      node.status({ fill: "yellow", shape: "ring", text: "initialising" });

      this.connection.on("error", function(error) {
        console.error(error);
        node.status({ fill: "red", shape: "ring", text: "error" });
        node.busy = false;
      });
      this.connection.on("open", function(error) {
        node.status({ fill: "green", shape: "dot", text: "connected" });
      });
      this.connection.on("close", function(error) {
        node.status({ fill: "red", shape: "dot", text: "not connected" });
        node.busy = false;
      });
      function handleError(err, msg, node, config, dont_send_msg){
        if(typeof err === "string"){
          err = new Error(err);
        }
        if(!config) config = {};
        if(typeof config === "string"){
          config = {
            errorHandling: config
          }
        }
        switch (config.errorHandling) {
          case "throw":
            node.error(err,msg);
            break;
          case "msg":
            msg.error = err;
            if(!dont_send_msg) node.send(msg);//send error on 1st pin
            break;
          case "output2":
            node.send([null,{payload: err}]);//send error on 2nd pin
            break;
                
          default:
            node.error(err,msg);
            break;
        }
      }
      function myReply(problem, msg) {
        clearTimeout(node.busyMonitor);
        if (!node.busy) {
          return; //not busy - dont process the reply (node may have timed out)
        }
        node.busy = false; //reset busy - allow node to be triggered
        node.msgMem.mcReadDetails = {};
        node.msgMem.mcReadDetails.request = node.request;
        node.msgMem.mcReadDetails.response = msg;
        node.msgMem.mcReadDetails.timeout = msg.timeout; //TODO
        node.msgMem.mcReadDetails.error = problem;
        node.msgMem.payload = null;
        if(problem){
          msg.problem = true;
        }
        if (msg.timeout) {
          node.status({ fill: "red", shape: "ring", text: "timeout" });
          handleError("timeout", msg, config);
          //node.error("timeout", msg);
          var dbgmsg = {
            f: "myReply(msg)",
            msg: msg,
            error: "timeout"
          };
          console.error(dbgmsg);
          node.msgMem.mcReadDetails.errorMsg = "timeout";
          node.send(node.msgMem);
          return;
        }

        if (problem) {
          node.status({ fill: "grey", shape: "ring", text: "Quality Issue" });
        } else {
          node.status({ fill: "green", shape: "dot", text: "Good" });
        }

        // msg.deviceCode
        // msg.digitSpec
        // msg.dataType
        // msg.deviceNo
        // msg.isGood
        // msg.quality
        // msg.TAG
        // msg.addr
        // msg.timeTaken
        // msg.timeStamp
        // msg.value
        // msg.valueType

        var data = msg.value;
        if (data != null && !problem) {
          let iWD = msg.deviceNo;
          let loopBit = 0,
            bitNo = msg.bitOffset;
          let JSONData = {};
          if (node.outputFormat == 0 /*JSON*/) {
            if (msg.valueType == "CHAR") {
              if (msg.deviceCodeNotation == "Hexadecimal") {
                buff_address = `${msg.deviceCode}${Number(iWD)
                  .toString(16)
                  .toUpperCase()}`;
              } else {
                buff_address = `${msg.deviceCode}${iWD}`;
              }
              JSONData[buff_address] = data;
            } else {
              if(!Array.isArray(data)) data = [data];
              for (var x in data) {
                let buff_address = "";
                if (msg.dataType == "BIT" && msg.deviceCodeType != "BIT") {
                  bitNo = msg.bitOffset + loopBit;
                  if (bitNo == 16) iWD++;
                  if (bitNo >= 16) {
                    bitNo = bitNo - 16;
                  }
                  if (msg.deviceCodeNotation == "Hexadecimal") {
                    buff_address = `${msg.deviceCode}${Number(iWD)
                      .toString(16)
                      .toUpperCase()}.${Number(bitNo)
                      .toString(16)
                      .toUpperCase()}`;
                  } else {
                    buff_address = `${msg.deviceCode}${iWD}.${Number(bitNo)
                      .toString(16)
                      .toUpperCase()}`;
                  }
                  JSONData[buff_address] = data[x];
                  loopBit++;
                  if (loopBit >= 16) loopBit = 0;
                } else {
                  if (msg.deviceCodeNotation == "Hexadecimal") {
                    buff_address = `${msg.deviceCode}${Number(iWD)
                      .toString(16)
                      .toUpperCase()}`;
                  } else {
                    buff_address = `${msg.deviceCode}${iWD}`;
                  }
                  JSONData[buff_address] = data[x];
                  iWD += msg.dataTypeByteLength / 2;
                }
              }
            }
            node.msgMem.payload = JSONData;
          } else {
            node.msgMem.payload = data;
          }
        }
        if(problem) {
          handleError(msg.error || "", node.msgMem, node, node.errorHandling);
        } else {
          node.send(node.msgMem);
        }
      }

      this.on("input", function(msg) {
        if (msg.disconnect === true || msg.topic === "disconnect") {
          this.connection.closeConnection();
          return;
        } else if (msg.connect === true || msg.topic === "connect") {
          this.connection.connect();
          return;
        }

        if (node.busy) return; //TODO: Consider queueing inputs?

        node.request = undefined;
        node.msgMem = msg;

        var addr;
        RED.util.evaluateNodeProperty(
          node.address,
          node.addressType,
          node,
          msg,
          (err, value) => {
            if (err) {
              handleError("Unable to evaluate address", msg, node, node.errorHandling);
              //node.error("Unable to evaluate address", msg);
              node.status({
                fill: "red",
                shape: "ring",
                text: "Unable to evaluate address"
              });
              return;
            } else {
              addr = value;
            }
          }
        );

        if (addr == "") {
          handleError("address is empty", msg, node, node.errorHandling);
          //node.error("address is empty", msg);
          node.status({ fill: "red", shape: "ring", text: "error" });
          return;
        }

        try {
          node.status({ fill: "yellow", shape: "ring", text: "read" });
          node.busy = true;

          node.request = {
            outputFormat: node.outputFormat ? "Array" : "JSON",
            address: addr,
            timeStamp: Date.now()
          };

          if (node.busyTimeMax) {
            node.busyMonitor = setTimeout(function() {
              if (node.busy) {
                node.status({ fill: "red", shape: "ring", text: "timeout" });
                handleError("timeout", msg, node, node.errorHandling);
                //node.error("timeout", msg || node.msgMem || {});
                node.busy = false;
                return;
              }
            }, node.busyTimeMax);
          }
          this.connection.read(addr, myReply);
        } catch (error) {
          node.busy = false;
          handleError(error, msg, node, node.errorHandling);
          //node.error(error, msg || node.msgMem || {});
          node.status({ fill: "red", shape: "ring", text: "error" });
          var dbgmsg = {
            info: "read.js-->on 'input'",
            connection: `host: ${node.connectionConfig.host}, port: ${node.connectionConfig.port}`,
            address: addr
          };
          node.debug(dbgmsg);
          return;
        }
      });
      node.status({ fill: "green", shape: "ring", text: "ready" });
    } else {
      node.error("configuration not setup");
      node.status({ fill: "red", shape: "ring", text: "error" });
    }
  }
  RED.nodes.registerType("MC Read", mcRead);
  mcRead.prototype.close = function() {
    if (this.connection) {
      this.connection.disconnect();
    }
  };
};
