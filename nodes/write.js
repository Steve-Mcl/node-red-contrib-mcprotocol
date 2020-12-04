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
  var util = require("util");
  function isNumeric(n) {
    return !isNaN(parseFloat(n)) && isFinite(n);
  }
  function mcWrite(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name;
    this.topic = config.topic;
    this.connection = config.connection;
    this.address = config.address;
    this.data = config.data;
    this.address = config.address || ""; //address
    this.addressType = config.addressType || "str";
    this.data = config.data || ""; //data
    this.dataType = config.dataType || "num";
    this.errorHandling = config.errorHandling;
    this.outputs = config.errorHandling === "output2" ? 2 : 1;//1 output pins if throw or msg.error, 2 outputs if errors to go to seperate output pin
    this.logLevel = RED.settings.logging.console.level;
    this.connectionConfig = RED.nodes.getNode(this.connection);
    var context = this.context();
    var node = this;
    node.busy = false;
    node.busyTimeMax = 1000; //Initial value, will be updated bt selected connection
    //var mcprotocol = require('../mcprotocol.js');
    if (this.connectionConfig) {
      node.status({ fill: "yellow", shape: "ring", text: "initialising" });
      var options = Object.assign({}, node.connectionConfig.options);
      options.logLevel = this.logLevel;
      this.connection = connection_pool.get(
        this.connectionConfig.port,
        this.connectionConfig.host,
        options
      );
      if(options.timeout && isNumeric(options.timeout)) node.busyTimeMax = parseInt(options.timeout);

      this.connection.on("error", function(error) {
        console.error(error);
        node.status({ fill: "red", shape: "ring", text: "error" });
      });
      this.connection.on("open", function(error) {
        node.status({ fill: "green", shape: "dot", text: "connected" });
      });
      this.connection.on("close", function(error) {
        node.status({ fill: "red", shape: "dot", text: "not connected" });
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
        node.busy = false; //reset busy - allow node to be triggered
        clearTimeout(node.busyMonitor);

        if (msg.timeout) {
          node.status({ fill: "red", shape: "ring", text: "timeout" });
          handleError("timeout", msg, node, node.errorHandling);
          //node.error("timeout", msg);
          var dbgmsg = {
            f: "myReply(msg)",
            msg: msg,
            error: "timeout"
          };
          console.error(dbgmsg);
          return; //halt flow
        }

        if (problem) {
          msg.problem = true;
          node.status({ fill: "grey", shape: "ring", text: "Quality Issue" });
        } else {
          node.status({ fill: "green", shape: "dot", text: "Good" });
        }
        node.msgMem.payload = !problem;
        node.msgMem.mcWriteDetails = msg;
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

        var isObject = function(val) {
          if (val === null) {
            return false;
          }
          return typeof val === "function" || typeof val === "object";
        };
        var addr; // = /* node.address || */ config.address || msg.payload.address;
        var data;
        //address - address
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
              if (addr == "") {
                handleError("address is empty", msg, node, node.errorHandling);
                //node.error("address is empty", msg);
                node.status({
                  fill: "red",
                  shape: "ring",
                  text: "address is empty"
                });
                return;
              }
            }
          }
        );

        //data - data
        node.trace("node.data...");
        node.trace(node.data);

        // var csv2arr = function (str) {
        //   return node.data.split(',').map(Number);
        // }
        if (node.dataType == "str") {
          node.trace("mcwrite input:node.dataType == 'str'");
          data = node.data;
        } else if (node.dataType == "num") {
          node.trace("mcwrite input:node.dataType == 'num'");
          //data = [node.data];
          data = node.data;
        } else if (node.dataType == "csv") {
          node.trace("mcwrite input:node.dataType == 'csv'");
          //data = csv2arr(node.data);
          data = node.data;
        } else {
          node.trace("mcwrite input:evaluateNodeProperty");
          RED.util.evaluateNodeProperty(
            node.data,
            node.dataType,
            node,
            msg,
            (err, value) => {
              if (err) {
                msg.dataerr = err;
                handleError("Unable to evaluate data", msg, node, node.errorHandling);
                //node.error("Unable to evaluate data", msg);
                node.status({
                  fill: "red",
                  shape: "ring",
                  text: "Unable to evaluate data"
                });
                return;
              } else {
                data = value;
              }
            }
          );
        }

        if (data == null) {
          handleError("data is empty", msg, node, node.errorHandling);
          //node.error("Data is empty", msg);
          return;
        }

        try {
          node.status({ fill: "yellow", shape: "ring", text: "write" });
          node.busy = true;
          if (node.busyTimeMax) {
            this.busyMonitor = setTimeout(function() {
              if (node.busy) {
                node.status({ fill: "red", shape: "ring", text: "timeout" });
                handleError("timeout", msg, node, node.errorHandling);
                //node.error("timeout", msg || node.msgMem || {});
                node.busy = false;
                return;
              }
            }, node.busyTimeMax);
          }

          node.trace("mcwrite input:  addr,  data...");
          node.trace(addr);
          node.trace(data);

          this.connection.write(addr, data, myReply);
        } catch (error) {
          node.busy = false;
          //node.error(error, msg || node.msgMem || {});
          handleError(error, msg, node, node.errorHandling);
          node.status({ fill: "red", shape: "ring", text: "error" });
          var dbgmsg = {
            info:
              "write.js-->on 'input' - try this.connection.write(addr, data, myReply)",
            connection: `host: ${node.connectionConfig.host}, port: ${node.connectionConfig.port}`,
            address: addr,
            data: data,
            error: error
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
  RED.nodes.registerType("MC Write", mcWrite);
  mcWrite.prototype.close = function() {
    if (this.connection) {
      this.connection.disconnect();
    }
  };
};
